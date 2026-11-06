import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CSV_LIMITS, writeCsvFile } from "../electron/passwords/csv";
import { PasswordError } from "../electron/passwords/errors";
import type { FormBroker } from "../electron/passwords/forms";
import {
  CLIPBOARD_CLEAR_MS,
  PASSWORD_CHANNELS,
  TRASH_TOKEN_MS,
  errorResult,
  registerPasswordIpc,
} from "../electron/passwords/ipc";
import {
  createReauth,
  REAUTH_REASONS,
  REAUTH_WINDOW_MS,
  type Reauth,
  type ReauthPurpose,
} from "../electron/passwords/reauth";
import { memorySealer } from "../electron/passwords/seal";
import { Vault, type VaultFiles } from "../electron/passwords/vault";
import type { PasswordErrorBody } from "../shared/types";

const posix = process.platform !== "win32";

// Which digests the clipboard copy takes, so the kept value can be checked
// without reading it.
const { hashes } = vi.hoisted(() => ({ hashes: [] as string[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (algorithm: string) => {
      hashes.push(algorithm);
      return actual.createHash(algorithm);
    },
  };
});

// Every channel the shell calls, in the order the bridge names them.
const REGISTERED = [
  PASSWORD_CHANNELS.status,
  PASSWORD_CHANNELS.list,
  PASSWORD_CHANNELS.reveal,
  PASSWORD_CHANNELS.copy,
  PASSWORD_CHANNELS.add,
  PASSWORD_CHANNELS.update,
  PASSWORD_CHANNELS.remove,
  PASSWORD_CHANNELS.importFile,
  PASSWORD_CHANNELS.trashFile,
  PASSWORD_CHANNELS.exportFile,
  PASSWORD_CHANNELS.answer,
  PASSWORD_CHANNELS.retry,
  PASSWORD_CHANNELS.startOver,
  PASSWORD_CHANNELS.neverSaved,
  PASSWORD_CHANNELS.removeNeverSaved,
];

const stop: (() => void)[] = [];
const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const unregister of stop.splice(0)) unregister();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
  hashes.length = 0;
});

// A vault file that lives in memory. read waits a turn, so a call that does
// not await open() sees the opening state.
function memoryFiles(): VaultFiles & { bytes?: Buffer } {
  const files: VaultFiles & { bytes?: Buffer } = {
    async read() {
      await Promise.resolve();
      return files.bytes;
    },
    async write(_path, data) {
      files.bytes = data;
    },
    async rename() {
      files.bytes = undefined;
    },
  };
  return files;
}

function fakeClipboard() {
  let text = "";
  return {
    writeText: vi.fn(async (value: string) => {
      text = value;
    }),
    readText: vi.fn(async () => text),
    clear: vi.fn(() => {
      text = "";
    }),
    // What the person copied somewhere else.
    put: (value: string) => {
      text = value;
    },
    text: () => text,
  };
}

const CSV = "url,username,password\r\nhttps://example.com,ada,secret-1\r\n";

// The chosen file, the save dialog and the Trash, with every path recorded.
function fakeFiles() {
  const files = {
    chosen: "/Users/ada/Downloads/chrome.csv" as string | undefined,
    saved: "/Users/ada/Downloads/Kamapathy Passwords.csv" as string | undefined,
    text: CSV,
    bytes: undefined as number | undefined,
    order: [] as string[],
    written: [] as { path: string; text: string }[],
    trashed: [] as string[],
    defaults: [] as string[],
    choose: vi.fn(async () => files.chosen),
    size: vi.fn(async () => files.bytes ?? Buffer.byteLength(files.text)),
    read: vi.fn(async () => Buffer.from(files.text, "utf8")),
    saveTo: vi.fn(async (defaultPath: string) => {
      files.order.push("saveTo");
      files.defaults.push(defaultPath);
      return files.saved;
    }),
    write: vi.fn(async (path: string, text: string) => {
      files.order.push("write");
      files.written.push({ path, text });
    }),
    trash: vi.fn(async (path: string) => {
      files.trashed.push(path);
    }),
  };
  return files;
}

function setup(
  options: {
    validate?: (event: IpcMainInvokeEvent) => void;
    vault?: Vault;
    reauth?: Reauth;
    forms?: FormBroker | null;
    files?: ReturnType<typeof fakeFiles>;
    confirmExport?: () => Promise<boolean>;
    exclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  } = {},
) {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >();
  const ipcMain = {
    handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };
  const vault =
    options.vault ??
    new Vault({
      path: "/passwords/vault.bin",
      sealer: memorySealer(),
      files: memoryFiles(),
    });
  // The check of a harness given its own Reauth is never called.
  const check = vi.fn(async (_purpose: ReauthPurpose) => {});
  const reauth: Reauth = options.reauth ?? { check, forget: vi.fn() };
  const clipboard = fakeClipboard();
  const vaultDep = vi.fn(() => vault);
  const formsDep = vi.fn(() => options.forms ?? null);
  const validate = vi.fn(options.validate ?? (() => {}));
  const files = options.files ?? fakeFiles();
  const confirmExport = vi.fn(
    options.confirmExport ??
      (async () => {
        files.order.push("confirm");
        return true;
      }),
  );
  const exclusive = vi.fn(
    options.exclusive ?? (<T>(work: () => Promise<T>) => work()),
  );
  const unregister = registerPasswordIpc({
    ipcMain,
    validate,
    vault: vaultDep,
    reauth,
    forms: formsDep,
    clipboard,
    files,
    confirmExport,
    downloads: () => "/Users/ada/Downloads",
    exclusive: exclusive as <T>(work: () => Promise<T>) => Promise<T>,
  });
  stop.push(unregister);
  return {
    vault,
    check,
    clipboard,
    files,
    confirmExport,
    exclusive,
    vaultDep,
    formsDep,
    validate,
    unregister,
    channels: () => [...handlers.keys()],
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      if (!handler) return Promise.reject(new Error(`No handler: ${channel}`));
      return Promise.resolve().then(() =>
        handler({} as IpcMainInvokeEvent, ...args),
      );
    },
  };
}

const sample = {
  url: "https://example.com/sign-in",
  username: "ada",
  password: "secret-1",
};
type Row = Record<string, string>;
const failed = (result: unknown): PasswordErrorBody => {
  expect(result).toHaveProperty("error");
  return (result as { error: PasswordErrorBody }).error;
};

describe("passwords shell IPC", () => {
  it("untrusted senders are refused", async () => {
    const refusal = new Error(
      "This operation is available only to the browser interface.",
    );
    const harness = setup({
      validate: () => {
        throw refusal;
      },
    });
    expect(harness.channels()).toEqual(REGISTERED);
    for (const channel of harness.channels())
      await expect(harness.invoke(channel, "id", "username")).rejects.toBe(
        refusal,
      );
    expect(harness.validate).toHaveBeenCalledTimes(REGISTERED.length);
    expect(harness.vaultDep).not.toHaveBeenCalled();
    expect(harness.formsDep).not.toHaveBeenCalled();
    expect(harness.check).not.toHaveBeenCalled();
    expect(harness.clipboard.writeText).not.toHaveBeenCalled();
    expect(harness.clipboard.readText).not.toHaveBeenCalled();
    expect(harness.clipboard.clear).not.toHaveBeenCalled();
  });

  it("show, copy password, edit and export need a check within 60 s; nothing else does", async () => {
    const harness = setup();
    const added = (await harness.invoke(PASSWORD_CHANNELS.add, sample)) as Row;
    expect(harness.check).not.toHaveBeenCalled();
    await harness.invoke(PASSWORD_CHANNELS.reveal, added.id);
    expect(harness.check).toHaveBeenCalledWith("show");
    await harness.invoke(PASSWORD_CHANNELS.copy, added.id, "password");
    await harness.invoke(PASSWORD_CHANNELS.update, added.id, {
      username: "ada2",
    });
    expect(harness.check).toHaveBeenCalledTimes(3);
    expect(harness.check).toHaveBeenNthCalledWith(3, "show");

    harness.check.mockClear();
    await harness.invoke(PASSWORD_CHANNELS.status);
    await harness.invoke(PASSWORD_CHANNELS.list);
    await harness.invoke(PASSWORD_CHANNELS.copy, added.id, "username");
    await harness.invoke(PASSWORD_CHANNELS.add, {
      ...sample,
      username: "grace",
    });
    await harness.invoke(PASSWORD_CHANNELS.remove, added.id);
    await harness.invoke(PASSWORD_CHANNELS.neverSaved);
    await harness.invoke(
      PASSWORD_CHANNELS.removeNeverSaved,
      "https://example.com",
    );
    await harness.invoke(PASSWORD_CHANNELS.retry);
    await harness.invoke(PASSWORD_CHANNELS.startOver);
    await harness.invoke(PASSWORD_CHANNELS.answer, "prompt-1", {
      action: "dismiss",
    });
    expect(harness.check).not.toHaveBeenCalled();

    // One check serves the window, and the next one asks again.
    let clock = 5000;
    const confirm = vi.fn(async () => true);
    const window = setup({
      reauth: createReauth({
        canPromptTouchID: () => false,
        promptTouchID: async () => {},
        confirm,
        now: () => clock,
      }),
    });
    const login = (await window.invoke(PASSWORD_CHANNELS.add, sample)) as Row;
    await window.invoke(PASSWORD_CHANNELS.reveal, login.id);
    expect(confirm).toHaveBeenCalledTimes(1);
    clock += REAUTH_WINDOW_MS;
    await window.invoke(PASSWORD_CHANNELS.reveal, login.id);
    expect(confirm).toHaveBeenCalledTimes(1);
    clock += 1;
    await window.invoke(PASSWORD_CHANNELS.reveal, login.id);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("a cancelled or failed check returns reauth_failed", async () => {
    const touchId = {
      canPromptTouchID: vi.fn(() => true),
      promptTouchID: vi.fn(async (_reason: string) => {
        throw new Error("Cancelled");
      }),
      confirm: vi.fn(async () => true),
    };
    const refused = setup({ reauth: createReauth(touchId) });
    const login = (await refused.invoke(PASSWORD_CHANNELS.add, sample)) as Row;
    const reveal = vi.spyOn(refused.vault, "reveal");
    expect(
      failed(await refused.invoke(PASSWORD_CHANNELS.reveal, login.id)),
    ).toEqual({ code: "reauth_failed", message: expect.any(String) });
    expect(reveal).not.toHaveBeenCalled();
    expect(touchId.promptTouchID).toHaveBeenCalledWith(REAUTH_REASONS.show);
    // A failed Touch ID is the answer; it never falls back to the dialog.
    expect(touchId.confirm).not.toHaveBeenCalled();

    // Without Touch ID the confirmation stands in, and Cancel refuses.
    const confirm = vi.fn(async () => false);
    const promptTouchID = vi.fn(async (_reason: string) => {});
    const cancelled = setup({
      reauth: createReauth({
        canPromptTouchID: () => false,
        promptTouchID,
        confirm,
      }),
    });
    const other = (await cancelled.invoke(
      PASSWORD_CHANNELS.add,
      sample,
    )) as Row;
    expect(
      failed(await cancelled.invoke(PASSWORD_CHANNELS.reveal, other.id)).code,
    ).toBe("reauth_failed");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(promptTouchID).not.toHaveBeenCalled();

    // Two actions at once share one prompt.
    let answer: (value: boolean) => void = () => {};
    const held = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const shared = createReauth({
      canPromptTouchID: () => false,
      promptTouchID: async () => {},
      confirm: held,
    });
    const both = [shared.check("show"), shared.check("export")];
    expect(held).toHaveBeenCalledTimes(1);
    answer(true);
    await Promise.all(both);
    expect(held).toHaveBeenCalledTimes(1);

    // Each purpose has its own Touch ID reason.
    const reasons = {
      canPromptTouchID: () => true,
      promptTouchID: vi.fn(async (_reason: string) => {}),
      confirm: async () => true,
    };
    await createReauth(reasons).check("export");
    expect(reasons.promptTouchID).toHaveBeenCalledWith(REAUTH_REASONS.export);
    expect(REAUTH_REASONS).toEqual({
      show: "show your saved passwords",
      export: "export your saved passwords",
    });
    // A forgotten check asks again.
    const again = createReauth(reasons);
    await again.check("show");
    again.forget();
    await again.check("show");
    expect(reasons.promptTouchID).toHaveBeenCalledTimes(3);
  });

  it("list leaves out passwords and notes and errors resolve as results", async () => {
    const harness = setup();
    const added = (await harness.invoke(PASSWORD_CHANNELS.add, {
      ...sample,
      note: "work account",
    })) as Row;
    const rows = (await harness.invoke(PASSWORD_CHANNELS.list)) as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "changedAt",
      "createdAt",
      "id",
      "kind",
      "origin",
      "username",
    ]);
    expect(JSON.stringify(rows)).not.toContain(sample.password);
    expect(JSON.stringify(rows)).not.toContain("work account");
    expect(rows[0].origin).toBe("https://example.com");

    expect(
      failed(
        await harness.invoke(PASSWORD_CHANNELS.add, {
          url: "http://example.org",
          username: "ada",
          password: "x".repeat(1001),
        }),
      ),
    ).toEqual({
      code: "invalid_login",
      field: "password",
      limit: 1000,
      message: expect.any(String),
    });
    expect(failed(await harness.invoke(PASSWORD_CHANNELS.add, sample))).toEqual(
      {
        code: "login_exists",
        id: added.id,
        message: expect.any(String),
      },
    );
    // Malformed arguments from the shell are answers, not crashes.
    expect(failed(await harness.invoke(PASSWORD_CHANNELS.reveal, 7)).code).toBe(
      "invalid_login",
    );
    expect(
      failed(
        await harness.invoke(PASSWORD_CHANNELS.add, {
          username: "ada",
          password: "secret",
        }),
      ),
    ).toEqual({
      code: "invalid_login",
      field: "url",
      message: expect.any(String),
    });
    expect(
      failed(await harness.invoke(PASSWORD_CHANNELS.copy, added.id, "note"))
        .code,
    ).toBe("invalid_login");
    expect(
      failed(await harness.invoke(PASSWORD_CHANNELS.answer, added.id, {})).code,
    ).toBe("invalid_login");
    // A note comes back only from reveal.
    expect(await harness.invoke(PASSWORD_CHANNELS.reveal, added.id)).toEqual({
      password: sample.password,
      note: "work account",
    });

    // status waits for the vault's first open.
    const slow = setup({
      vault: new Vault({
        path: "/passwords/vault.bin",
        sealer: memorySealer(),
        files: memoryFiles(),
      }),
    });
    expect(slow.vault.state).toBe("opening");
    expect(await slow.invoke(PASSWORD_CHANNELS.status)).toEqual({
      state: "empty",
      count: 0,
      compromised: 0,
    });

    // A vault the key cannot open answers with its state.
    const broken = memoryFiles();
    broken.bytes = Buffer.from("KPV1 not a vault");
    const locked = setup({
      vault: new Vault({
        path: "/passwords/vault.bin",
        sealer: memorySealer(),
        files: broken,
      }),
    });
    expect(failed(await locked.invoke(PASSWORD_CHANNELS.list)).code).toBe(
      "vault_locked",
    );
    expect(failed(await locked.invoke(PASSWORD_CHANNELS.neverSaved)).code).toBe(
      "vault_locked",
    );
    expect(locked.check).not.toHaveBeenCalled();
    expect(await locked.invoke(PASSWORD_CHANNELS.startOver)).toEqual({
      state: "empty",
      count: 0,
      compromised: 0,
    });

    // Anything that is not a passwords answer stays a rejection.
    const bug = new TypeError("undefined is not a function");
    expect(() => errorResult(bug)).toThrow(bug);
    expect(errorResult(new PasswordError("vault_locked"))).toEqual({
      error: { code: "vault_locked", message: expect.any(String) },
    });
  });

  it("a copied password leaves the clipboard after 60 s only if still there", async () => {
    vi.useFakeTimers();
    const harness = setup();
    const added = (await harness.invoke(PASSWORD_CHANNELS.add, sample)) as Row;
    expect(
      await harness.invoke(PASSWORD_CHANNELS.copy, added.id, "password"),
    ).toEqual({ ok: true });
    expect(harness.clipboard.writeText).toHaveBeenCalledWith(sample.password);
    // The password is kept as a digest, never as text.
    expect(hashes).toEqual(["sha256"]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS - 1);
    expect(harness.clipboard.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.clipboard.clear).toHaveBeenCalledTimes(1);
    expect(hashes).toEqual(["sha256", "sha256"]);

    // Something the person copied later stays.
    const kept = setup();
    const other = (await kept.invoke(PASSWORD_CHANNELS.add, sample)) as Row;
    await kept.invoke(PASSWORD_CHANNELS.copy, other.id, "password");
    kept.clipboard.put("a note of my own");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(kept.clipboard.clear).not.toHaveBeenCalled();
    expect(kept.clipboard.text()).toBe("a note of my own");

    // A username is copied without a check and without a timer.
    const names = setup();
    const named = (await names.invoke(PASSWORD_CHANNELS.add, sample)) as Row;
    expect(
      await names.invoke(PASSWORD_CHANNELS.copy, named.id, "username"),
    ).toEqual({ ok: true });
    expect(names.clipboard.writeText).toHaveBeenCalledWith(sample.username);
    expect(names.check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(
      failed(await names.invoke(PASSWORD_CHANNELS.copy, "none", "username"))
        .code,
    ).toBe("login_not_found");
  });

  it("prompt answers reach the current window's broker", async () => {
    const broker = { answer: vi.fn(async () => ({ ok: true }) as const) };
    const harness = setup({ forms: broker as unknown as FormBroker });
    expect(
      await harness.invoke(PASSWORD_CHANNELS.answer, "prompt-1", {
        action: "save",
        username: "ada",
        extra: "ignored",
      }),
    ).toEqual({ ok: true });
    expect(broker.answer).toHaveBeenCalledWith("prompt-1", {
      action: "save",
      username: "ada",
    });
    broker.answer.mockRejectedValueOnce(
      new PasswordError("invalid_login", { field: "username" }),
    );
    expect(
      failed(
        await harness.invoke(PASSWORD_CHANNELS.answer, "prompt-1", {
          action: "save",
          username: "ada",
        }),
      ).code,
    ).toBe("invalid_login");
    // Without a window there is no prompt to answer.
    const alone = setup();
    expect(
      await alone.invoke(PASSWORD_CHANNELS.answer, "prompt-1", {
        action: "never",
      }),
    ).toEqual({ ok: true });
  });
  it("import offers the file to the Trash by token, export checks, confirms and writes 0600", async () => {
    vi.useFakeTimers();
    const harness = setup();
    const files = harness.files;
    const result = (await harness.invoke(PASSWORD_CHANNELS.importFile, {
      replace: false,
    })) as { summary: Record<string, unknown>; file: Record<string, string> };
    expect(harness.exclusive).toHaveBeenCalledTimes(1);
    expect(result.summary).toEqual({
      added: 1,
      unchanged: 0,
      kept: 0,
      replaced: 0,
      skipped: 0,
      neverSaved: 0,
      warnings: [],
    });
    expect(result.file.name).toBe("chrome.csv");
    // The shell gets a token, never the path.
    expect(JSON.stringify(result)).not.toContain("/Users/ada/Downloads");
    expect(harness.vault.list()).toHaveLength(1);
    expect(
      failed(await harness.invoke(PASSWORD_CHANNELS.importFile, { replace: 1 }))
        .code,
    ).toBe("invalid_login");

    // The Trash offer works once, by that token only.
    expect(
      failed(await harness.invoke(PASSWORD_CHANNELS.trashFile, "other")).code,
    ).toBe("login_not_found");
    expect(
      await harness.invoke(PASSWORD_CHANNELS.trashFile, result.file.token),
    ).toEqual({ ok: true });
    expect(files.trashed).toEqual(["/Users/ada/Downloads/chrome.csv"]);
    expect(
      failed(
        await harness.invoke(PASSWORD_CHANNELS.trashFile, result.file.token),
      ).code,
    ).toBe("login_not_found");

    // Cancelling the file dialog reads nothing; an oversized file is refused
    // before it is read; and the token is forgotten after ten minutes.
    files.chosen = undefined;
    expect(
      await harness.invoke(PASSWORD_CHANNELS.importFile, { replace: false }),
    ).toEqual({ canceled: true });
    expect(files.read).toHaveBeenCalledTimes(1);
    files.chosen = "/Users/ada/Downloads/chrome.csv";
    files.bytes = CSV_LIMITS.bytes + 1;
    expect(
      failed(
        await harness.invoke(PASSWORD_CHANNELS.importFile, { replace: false }),
      ),
    ).toEqual({
      code: "import_file_invalid",
      reason: "size",
      message: expect.any(String),
    });
    expect(files.read).toHaveBeenCalledTimes(1);
    files.bytes = undefined;
    const second = (await harness.invoke(PASSWORD_CHANNELS.importFile, {
      replace: false,
    })) as { file: Record<string, string> };
    await vi.advanceTimersByTimeAsync(TRASH_TOKEN_MS);
    expect(
      failed(
        await harness.invoke(PASSWORD_CHANNELS.trashFile, second.file.token),
      ).code,
    ).toBe("login_not_found");
    expect(files.trashed).toHaveLength(1);

    // An import already running answers section 15's import_busy.
    const busy = setup({
      exclusive: async () => {
        const error = new Error("An import is already running.");
        (error as { code?: string }).code = "import_busy";
        throw error;
      },
    });
    expect(
      failed(
        await busy.invoke(PASSWORD_CHANNELS.importFile, { replace: true }),
      ),
    ).toEqual({
      code: "import_busy",
      message: "An import is already running.",
      retryable: true,
    });
    expect(busy.files.choose).not.toHaveBeenCalled();

    // Export: the check, the warning, the save dialog, then a 0600 file.
    const folder = mkdtempSync(join(tmpdir(), "kamapathy-export-"));
    folders.push(folder);
    const target = join(folder, "Kamapathy Passwords.csv");
    const exported = fakeFiles();
    exported.saved = target;
    exported.write.mockImplementation(async (path: string, text: string) => {
      exported.order.push("write");
      await writeCsvFile(path, text);
    });
    const out = setup({
      files: exported,
      reauth: {
        check: vi.fn(async (purpose: ReauthPurpose) => {
          exported.order.push(`check:${purpose}`);
        }),
        forget: vi.fn(),
      },
    });
    await out.invoke(PASSWORD_CHANNELS.add, sample);
    await out.invoke(PASSWORD_CHANNELS.add, { ...sample, username: "grace" });
    expect(await out.invoke(PASSWORD_CHANNELS.exportFile)).toEqual({
      count: 2,
      name: "Kamapathy Passwords.csv",
    });
    expect(exported.order).toEqual([
      "check:export",
      "confirm",
      "saveTo",
      "write",
    ]);
    expect(exported.defaults).toEqual([
      join("/Users/ada/Downloads", "Kamapathy Passwords.csv"),
    ]);
    // Windows has no POSIX mode bits.
    if (posix) expect(statSync(target).mode & 0o777).toBe(0o600);
    const text = readFileSync(target, "utf8");
    expect(text.split("\r\n")[0]).toBe("name,url,username,password,note");
    expect(text).toContain(sample.password);
    // Written again, the file keeps its mode.
    await out.invoke(PASSWORD_CHANNELS.exportFile);
    if (posix) expect(statSync(target).mode & 0o777).toBe(0o600);

    // Cancel at the warning or the save dialog writes nothing.
    const stopped = fakeFiles();
    const warned = setup({ files: stopped, confirmExport: async () => false });
    await warned.invoke(PASSWORD_CHANNELS.add, sample);
    expect(await warned.invoke(PASSWORD_CHANNELS.exportFile)).toEqual({
      canceled: true,
    });
    expect(warned.check).toHaveBeenCalledWith("export");
    expect(stopped.saveTo).not.toHaveBeenCalled();
    expect(stopped.write).not.toHaveBeenCalled();
    const closed = fakeFiles();
    closed.saved = undefined;
    const kept = setup({ files: closed });
    await kept.invoke(PASSWORD_CHANNELS.add, sample);
    expect(await kept.invoke(PASSWORD_CHANNELS.exportFile)).toEqual({
      canceled: true,
    });
    expect(closed.write).not.toHaveBeenCalled();

    // A refused check exports nothing.
    const refused = setup({
      reauth: {
        check: vi.fn(async () => {
          throw new PasswordError("reauth_failed");
        }),
        forget: vi.fn(),
      },
    });
    expect(
      failed(await refused.invoke(PASSWORD_CHANNELS.exportFile)).code,
    ).toBe("reauth_failed");
    expect(refused.confirmExport).not.toHaveBeenCalled();
    expect(refused.files.write).not.toHaveBeenCalled();
  });
});
