import { createHash } from "node:crypto";
import type { Clipboard, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  PasswordErrorBody,
  PasswordPromptAnswer,
} from "../../shared/types";
import { PasswordError, passwordErrorBody } from "./errors";
import type { FormBroker } from "./forms";
import { loginOrigin } from "./origin";
import type { Reauth } from "./reauth";
import type { Vault, VaultChanges } from "./vault";

export const PASSWORD_CHANNELS = {
  status: "kamapathy:passwords:status",
  list: "kamapathy:passwords:list",
  reveal: "kamapathy:passwords:reveal",
  copy: "kamapathy:passwords:copy",
  add: "kamapathy:passwords:add",
  update: "kamapathy:passwords:update",
  remove: "kamapathy:passwords:remove",
  importFile: "kamapathy:passwords:import-file",
  trashFile: "kamapathy:passwords:trash-file",
  exportFile: "kamapathy:passwords:export-file",
  answer: "kamapathy:passwords:answer",
  retry: "kamapathy:passwords:retry",
  startOver: "kamapathy:passwords:start-over",
  neverSaved: "kamapathy:passwords:never-saved",
  removeNeverSaved: "kamapathy:passwords:remove-never-saved",
} as const;

export const CLIPBOARD_CLEAR_MS = 60000;
// Ids and tokens come from the shell's own rows.
const ID_LIMIT = 64;

export interface PasswordIpcDeps {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  validate(event: IpcMainInvokeEvent): void;
  vault(): Vault;
  reauth: Reauth;
  forms(): FormBroker | null;
  clipboard: Pick<Clipboard, "writeText" | "readText" | "clear">;
  now?: () => number;
}

// A passwords answer is a result; anything else is a bug and rejects.
export function errorResult(error: unknown): { error: PasswordErrorBody } {
  const body = passwordErrorBody(error);
  if (!body) throw error;
  return { error: body };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (field: string) =>
  new PasswordError("invalid_login", { field });

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(field);
  return value;
}
function idOf(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > ID_LIMIT)
    throw invalid("id");
  return value;
}
function fieldOf(value: unknown): "username" | "password" {
  if (value !== "username" && value !== "password") throw invalid("field");
  return value;
}
// What the person typed in Add password. A bare host becomes https://.
function newLogin(value: unknown): {
  origin: string;
  username: string;
  password: string;
  note?: string;
} {
  if (!isRecord(value)) throw invalid("url");
  const origin = loginOrigin(text(value.url, "url"));
  const username = text(value.username, "username");
  const password = text(value.password, "password");
  const note = value.note === undefined ? undefined : text(value.note, "note");
  return {
    origin,
    username,
    password,
    ...(note === undefined ? {} : { note }),
  };
}
function loginChanges(value: unknown): VaultChanges {
  if (!isRecord(value)) throw invalid("url");
  const changes: VaultChanges = {};
  if (value.url !== undefined)
    changes.origin = loginOrigin(text(value.url, "url"));
  if (value.username !== undefined)
    changes.username = text(value.username, "username");
  if (value.password !== undefined)
    changes.password = text(value.password, "password");
  // An empty note removes it.
  if (value.note !== undefined) changes.note = text(value.note, "note") || null;
  return changes;
}
function answerOf(value: unknown): PasswordPromptAnswer {
  if (!isRecord(value)) throw invalid("action");
  switch (value.action) {
    case "save":
      return { action: "save", username: text(value.username, "username") };
    case "update":
      return { action: "update" };
    case "never":
      return { action: "never" };
    case "dismiss":
      return { action: "dismiss" };
    default:
      throw invalid("action");
  }
}

// Every call that reads waits for the vault's first open, and says why it
// cannot answer instead of answering empty.
async function opened(vault: Vault): Promise<void> {
  await vault.open();
  if (vault.state === "locked") throw new PasswordError("vault_locked");
}
async function readable(vault: Vault): Promise<void> {
  await opened(vault);
  const { state, reason } = vault.status();
  if (state === "unavailable")
    throw new PasswordError("vault_unavailable", reason ? { reason } : {});
}

export function registerPasswordIpc(deps: PasswordIpcDeps): () => void {
  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const channels: string[] = [];
  let copied:
    { digest: string; timer: ReturnType<typeof setTimeout> } | undefined;

  // A copied password leaves the clipboard, unless the person copied
  // something else in the meantime. Only its digest is kept.
  function holdCopy(password: string): void {
    if (copied) clearTimeout(copied.timer);
    const kept = digest(password);
    copied = {
      digest: kept,
      timer: setTimeout(() => {
        copied = undefined;
        void deps.clipboard.readText().then((text) => {
          if (digest(text) === kept) deps.clipboard.clear();
        });
      }, CLIPBOARD_CLEAR_MS),
    };
  }

  function register(
    channel: string,
    work: (...args: unknown[]) => Promise<unknown>,
  ): void {
    channels.push(channel);
    deps.ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      // An untrusted sender gets the rejection every other channel gives it.
      deps.validate(event);
      try {
        return await work(...args);
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  register(PASSWORD_CHANNELS.status, async () => {
    const vault = deps.vault();
    await vault.open();
    return vault.status();
  });
  register(PASSWORD_CHANNELS.list, async () => {
    const vault = deps.vault();
    await readable(vault);
    return vault.list();
  });
  register(PASSWORD_CHANNELS.reveal, async (id) => {
    const key = idOf(id);
    const vault = deps.vault();
    await readable(vault);
    await deps.reauth.check("show");
    return await vault.reveal(key);
  });
  register(PASSWORD_CHANNELS.copy, async (id, field) => {
    const key = idOf(id);
    const which = fieldOf(field);
    const vault = deps.vault();
    await readable(vault);
    if (which === "username") {
      const login = vault.get(key);
      if (!login) throw new PasswordError("login_not_found");
      await deps.clipboard.writeText(login.username);
      return { ok: true };
    }
    await deps.reauth.check("show");
    const { password } = await vault.reveal(key);
    await deps.clipboard.writeText(password);
    holdCopy(password);
    return { ok: true };
  });
  register(PASSWORD_CHANNELS.add, async (login) => {
    const input = newLogin(login);
    return await deps.vault().add({ kind: "form", ...input });
  });
  register(PASSWORD_CHANNELS.update, async (id, changes) => {
    const key = idOf(id);
    const next = loginChanges(changes);
    const vault = deps.vault();
    await readable(vault);
    await deps.reauth.check("show");
    return await vault.update(key, next);
  });
  register(PASSWORD_CHANNELS.remove, async (id) => {
    await deps.vault().remove(idOf(id));
    return { ok: true };
  });
  register(PASSWORD_CHANNELS.answer, async (promptId, answer) => {
    const id = idOf(promptId);
    const given = answerOf(answer);
    return (await deps.forms()?.answer(id, given)) ?? { ok: true };
  });
  register(PASSWORD_CHANNELS.retry, async () => {
    const vault = deps.vault();
    await vault.retry();
    return vault.status();
  });
  register(PASSWORD_CHANNELS.startOver, async () => {
    const vault = deps.vault();
    await vault.startOver();
    return vault.status();
  });
  register(PASSWORD_CHANNELS.neverSaved, async () => {
    const vault = deps.vault();
    await opened(vault);
    return vault.neverSaved();
  });
  register(PASSWORD_CHANNELS.removeNeverSaved, async (origin) => {
    await deps.vault().removeNeverSaved(text(origin, "url"));
    return { ok: true };
  });

  return () => {
    if (copied) clearTimeout(copied.timer);
    copied = undefined;
    for (const channel of channels) deps.ipcMain.removeHandler(channel);
  };
}
