import { useCallback, useEffect, useRef, useState } from "react";
import { Password, Plus, ShieldWarning } from "@phosphor-icons/react";
import type {
  LoginChanges,
  NeverSavedOrigin,
  PasswordImportSummary,
  SavedLoginSummary,
  VaultStatus,
} from "../../shared/types";
import { passwordsCopy } from "../copy";
import { bridge } from "../lib/bridge";
import {
  compromisedCount,
  filterLogins,
  importSummaryLines,
  isPasswordError,
  loginHost,
  sortLogins,
} from "../lib/passwords";
import { Modal } from "./ui";
import "./Passwords.css";

// A shown password hides itself again, like a copied one leaves the clipboard.
const SHOWN_MS = 60000;
const COPIED_MS = 2500;

interface Shown {
  password: string;
  note?: string;
}
interface Draft {
  url: string;
  username: string;
  password: string;
  note: string;
}
const emptyDraft: Draft = { url: "", username: "", password: "", note: "" };

export function PasswordsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={passwordsCopy.title}
      className="passwords-dialog"
    >
      {/* Closing the dialog drops every shown password with the body. */}
      {open && <PasswordsBody />}
    </Modal>
  );
}

function PasswordsBody() {
  const [status, setStatus] = useState<VaultStatus>();
  const [logins, setLogins] = useState<SavedLoginSummary[]>([]);
  const [blocked, setBlocked] = useState<NeverSavedOrigin[]>([]);
  const [query, setQuery] = useState("");
  const [onlyCompromised, setOnlyCompromised] = useState(false);
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const [error, setError] = useState<{ where: string; message: string }>();
  const [confirming, setConfirming] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [original, setOriginal] = useState<Draft>(emptyDraft);
  const [secretShown, setSecretShown] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [copiedAt, setCopiedAt] = useState(0);
  const [importing, setImporting] = useState(false);
  const [replace, setReplace] = useState(false);
  const [summary, setSummary] = useState<PasswordImportSummary>();
  const [imported, setImported] = useState<{ token: string; name: string }>();
  const [exported, setExported] = useState("");
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
      running.clear();
    };
  }, []);
  useEffect(() => {
    if (!copiedAt) return;
    const timer = setTimeout(() => setCopiedAt(0), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  const refresh = useCallback(async () => {
    const current = await bridge.passwords.status();
    if (isPasswordError(current)) {
      setStatus({
        state: "unavailable",
        reason: current.error.reason === "web" ? "web" : "no_keyring",
        count: 0,
        compromised: 0,
      });
      return;
    }
    setStatus(current);
    if (current.state !== "ready") {
      setLogins([]);
      setBlocked([]);
      return;
    }
    const [saved, never] = await Promise.all([
      bridge.passwords.list(),
      bridge.passwords.neverSaved(),
    ]);
    if (isPasswordError(saved))
      setError({ where: "vault", message: saved.error.message });
    setLogins(isPasswordError(saved) ? [] : saved);
    setBlocked(isPasswordError(never) ? [] : never);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hide = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setShown((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const reveal = async (id: string) => {
    const result = await bridge.passwords.reveal(id);
    if (isPasswordError(result)) {
      setError({ where: id, message: result.error.message });
      return undefined;
    }
    setError(undefined);
    setShown((current) => ({ ...current, [id]: result }));
    const previous = timers.current.get(id);
    if (previous) clearTimeout(previous);
    timers.current.set(
      id,
      setTimeout(() => hide(id), SHOWN_MS),
    );
    return result;
  };
  const copy = async (id: string, field: "username" | "password") => {
    const result = await bridge.passwords.copy(id, field);
    if (isPasswordError(result)) {
      setError({ where: id, message: result.error.message });
      return;
    }
    setError(undefined);
    setCopiedAt(Date.now());
  };
  const closeDraft = () => {
    setEditing("");
    setDraft(emptyDraft);
    setOriginal(emptyDraft);
    setSecretShown(false);
  };
  const openDraft = async (login?: SavedLoginSummary) => {
    setError(undefined);
    setConfirming("");
    if (!login) {
      setDraft(emptyDraft);
      setOriginal(emptyDraft);
      setSecretShown(false);
      setEditing("add");
      return;
    }
    const values = await reveal(login.id);
    if (!values) return;
    const current: Draft = {
      url: login.origin,
      username: login.username,
      password: values.password,
      note: values.note ?? "",
    };
    setDraft(current);
    setOriginal(current);
    setSecretShown(true);
    setEditing(login.id);
  };
  const saveDraft = async () => {
    if (editing === "add") {
      const result = await bridge.passwords.add({
        url: draft.url.trim(),
        username: draft.username.trim(),
        password: draft.password,
        ...(draft.note ? { note: draft.note } : {}),
      });
      if (isPasswordError(result)) {
        setError({ where: "form", message: result.error.message });
        return;
      }
    } else {
      const changes: LoginChanges = {};
      if (draft.url.trim() !== original.url) changes.url = draft.url.trim();
      if (draft.username.trim() !== original.username)
        changes.username = draft.username.trim();
      if (draft.password !== original.password)
        changes.password = draft.password;
      // An empty note removes it.
      if (draft.note !== original.note) changes.note = draft.note;
      if (Object.keys(changes).length) {
        const result = await bridge.passwords.update(editing, changes);
        if (isPasswordError(result)) {
          setError({ where: "form", message: result.error.message });
          return;
        }
        hide(editing);
      }
    }
    closeDraft();
    setError(undefined);
    await refresh();
  };
  const remove = async (id: string) => {
    const result = await bridge.passwords.remove(id);
    if (isPasswordError(result)) {
      setError({ where: id, message: result.error.message });
      return;
    }
    setConfirming("");
    hide(id);
    setError(undefined);
    await refresh();
  };
  const forget = async (origin: string) => {
    const result = await bridge.passwords.removeNeverSaved(origin);
    if (isPasswordError(result)) {
      setError({ where: origin, message: result.error.message });
      return;
    }
    setError(undefined);
    await refresh();
  };
  const clearTransfer = () => {
    setSummary(undefined);
    setImported(undefined);
    setExported("");
    setError(undefined);
  };
  const runImport = async () => {
    const result = await bridge.passwords.importFile({ replace });
    if (isPasswordError(result)) {
      setError({ where: "transfer", message: result.error.message });
      return;
    }
    clearTransfer();
    setImporting(false);
    if ("canceled" in result) return;
    setSummary(result.summary);
    setImported(result.file);
    await refresh();
  };
  const runExport = async () => {
    clearTransfer();
    setImporting(false);
    const result = await bridge.passwords.exportFile();
    if (isPasswordError(result)) {
      setError({ where: "transfer", message: result.error.message });
      return;
    }
    if ("canceled" in result) return;
    setExported(passwordsCopy.transfer.exported(result.count));
  };
  // The file is the person's; a Trash that fails leaves it where it is.
  const trashImported = async (token: string) => {
    setImported(undefined);
    const result = await bridge.passwords
      .trashFile(token)
      .catch(() => undefined);
    if (result && isPasswordError(result))
      setError({ where: "transfer", message: result.error.message });
  };
  const vaultAction = async (
    call: () => ReturnType<typeof bridge.passwords.retry>,
  ) => {
    const result = await call();
    if (isPasswordError(result)) {
      setError({ where: "vault", message: result.error.message });
      return;
    }
    setConfirming("");
    setError(undefined);
    await refresh();
  };

  if (!status || status.state === "opening")
    return (
      <p className="passwords-note" role="status">
        {passwordsCopy.opening}
      </p>
    );
  if (status.state === "unavailable")
    return (
      <p className="passwords-note">
        {status.reason === "web"
          ? passwordsCopy.web
          : passwordsCopy.unavailable}
      </p>
    );
  if (status.state === "locked")
    return (
      <>
        <p className="passwords-note">{passwordsCopy.locked}</p>
        {confirming === "start-over" ? (
          <>
            <p className="passwords-note">{passwordsCopy.startOverConfirm}</p>
            <div className="passwords-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  void vaultAction(() => bridge.passwords.startOver())
                }
              >
                {passwordsCopy.startOver}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirming("")}
              >
                {passwordsCopy.cancel}
              </button>
            </div>
          </>
        ) : (
          <div className="passwords-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void vaultAction(() => bridge.passwords.retry())}
            >
              {passwordsCopy.tryAgain}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirming("start-over")}
            >
              {passwordsCopy.startOver}
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error.message}
          </p>
        )}
      </>
    );

  const flagged = compromisedCount(logins);
  const rows = sortLogins(filterLogins(logins, query, onlyCompromised));
  return (
    <>
      {logins.length > 0 && (
        <input
          className="panel-search"
          aria-label={passwordsCopy.search}
          placeholder={passwordsCopy.search}
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="passwords-toolbar">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void openDraft()}
        >
          <Plus size={16} /> {passwordsCopy.add}
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-expanded={showBlocked}
          disabled={!blocked.length}
          onClick={() => setShowBlocked(!showBlocked)}
        >
          {passwordsCopy.neverSaved}
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-expanded={importing}
          onClick={() => {
            clearTransfer();
            setImporting(!importing);
          }}
        >
          {passwordsCopy.transfer.import}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void runExport()}
        >
          {passwordsCopy.transfer.export}
        </button>
        {copiedAt > 0 && (
          <span className="passwords-copied" role="status">
            {passwordsCopy.copied}
          </span>
        )}
      </div>
      {importing && (
        <div className="passwords-form">
          <label>
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            {passwordsCopy.transfer.replace}
          </label>
          <div className="passwords-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => void runImport()}
            >
              {passwordsCopy.transfer.start}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setImporting(false)}
            >
              {passwordsCopy.cancel}
            </button>
          </div>
        </div>
      )}
      {summary &&
        importSummaryLines(summary).map((line) => (
          <p className="passwords-note" role="status" key={line}>
            {line}
          </p>
        ))}
      {imported && (
        <>
          <p className="passwords-note">
            {passwordsCopy.transfer.trash(imported.name)}
          </p>
          <div className="passwords-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void trashImported(imported.token)}
            >
              {passwordsCopy.transfer.moveToTrash}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setImported(undefined)}
            >
              {passwordsCopy.transfer.keepFile}
            </button>
          </div>
        </>
      )}
      {exported && (
        <p className="passwords-note" role="status">
          {exported}
        </p>
      )}
      {error?.where === "transfer" && (
        <p className="form-error" role="alert">
          {error.message}
        </p>
      )}
      {editing && (
        <form
          className="passwords-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
        >
          <label className="field-label" htmlFor="password-url">
            {passwordsCopy.siteUrl}
          </label>
          <input
            id="password-url"
            className="text-input"
            value={draft.url}
            autoFocus
            onChange={(event) =>
              setDraft({ ...draft, url: event.target.value })
            }
          />
          <label className="field-label" htmlFor="password-username">
            {passwordsCopy.username}
          </label>
          <input
            id="password-username"
            className="text-input"
            value={draft.username}
            onChange={(event) =>
              setDraft({ ...draft, username: event.target.value })
            }
          />
          <label className="field-label" htmlFor="password-secret">
            {passwordsCopy.password}
          </label>
          <div className="passwords-secret">
            <input
              id="password-secret"
              className="text-input"
              type={secretShown ? "text" : "password"}
              value={draft.password}
              onChange={(event) =>
                setDraft({ ...draft, password: event.target.value })
              }
            />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSecretShown(!secretShown)}
            >
              {secretShown ? passwordsCopy.hide : passwordsCopy.show}
            </button>
          </div>
          <label className="field-label" htmlFor="password-note">
            {passwordsCopy.note}
          </label>
          <input
            id="password-note"
            className="text-input"
            value={draft.note}
            onChange={(event) =>
              setDraft({ ...draft, note: event.target.value })
            }
          />
          {error?.where === "form" && (
            <p className="form-error" role="alert">
              {error.message}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={closeDraft}
            >
              {passwordsCopy.cancel}
            </button>
            <button type="submit" className="primary-button">
              {passwordsCopy.save}
            </button>
          </div>
        </form>
      )}
      {flagged > 0 && (
        <div className="passwords-banner">
          <ShieldWarning size={18} />
          <span>{passwordsCopy.compromised(flagged)}</span>
          <button
            type="button"
            onClick={() => setOnlyCompromised(!onlyCompromised)}
          >
            {onlyCompromised
              ? passwordsCopy.showAll
              : passwordsCopy.showCompromised}
          </button>
        </div>
      )}
      {error?.where === "vault" && (
        <p className="form-error" role="alert">
          {error.message}
        </p>
      )}
      {/* A vault emptied by Delete reads like a new one. */}
      {!logins.length ? (
        <div className="empty-state">
          <span>
            <Password size={30} />
          </span>
          <p>{passwordsCopy.empty}</p>
        </div>
      ) : (
        <div className="passwords-list">
          {rows.map((login) => {
            const values = shown[login.id];
            return (
              <div className="passwords-row" key={login.id}>
                <div className="passwords-row-main">
                  <strong>
                    <bdi>{loginHost(login.origin)}</bdi>
                  </strong>
                  <small>
                    <bdi>{login.username || passwordsCopy.noUsername}</bdi>
                    {login.kind === "http" && login.realm && (
                      <span className="passwords-realm">
                        {passwordsCopy.realm(login.realm)}
                      </span>
                    )}
                    {login.compromised && (
                      <span className="passwords-tag">
                        {passwordsCopy.compromisedTag}
                      </span>
                    )}
                  </small>
                  {values && (
                    <p className="passwords-value">
                      <code>{values.password}</code>
                      {values.note && <bdi>{values.note}</bdi>}
                    </p>
                  )}
                  {error?.where === login.id && (
                    <p className="form-error" role="alert">
                      {error.message}
                    </p>
                  )}
                </div>
                <div className="passwords-row-actions">
                  {confirming === login.id ? (
                    <>
                      <span>{passwordsCopy.confirmDelete}</span>
                      <button
                        type="button"
                        className="passwords-danger"
                        onClick={() => void remove(login.id)}
                      >
                        {passwordsCopy.delete}
                      </button>
                      <button type="button" onClick={() => setConfirming("")}>
                        {passwordsCopy.cancel}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          values ? hide(login.id) : void reveal(login.id)
                        }
                      >
                        {values ? passwordsCopy.hide : passwordsCopy.show}
                      </button>
                      <button
                        type="button"
                        onClick={() => void copy(login.id, "username")}
                      >
                        {passwordsCopy.copyUsername}
                      </button>
                      <button
                        type="button"
                        onClick={() => void copy(login.id, "password")}
                      >
                        {passwordsCopy.copyPassword}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openDraft(login)}
                      >
                        {passwordsCopy.edit}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(login.id)}
                      >
                        {passwordsCopy.delete}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showBlocked && blocked.length > 0 && (
        <section className="passwords-never">
          <h4>{passwordsCopy.neverSaved}</h4>
          <div className="passwords-list">
            {blocked.map((entry) => (
              <div className="passwords-row" key={entry.origin}>
                <div className="passwords-row-main">
                  <strong>
                    <bdi>{loginHost(entry.origin)}</bdi>
                  </strong>
                  {error?.where === entry.origin && (
                    <p className="form-error" role="alert">
                      {error.message}
                    </p>
                  )}
                </div>
                <div className="passwords-row-actions">
                  <button
                    type="button"
                    onClick={() => void forget(entry.origin)}
                  >
                    {passwordsCopy.remove}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="library-footnote">{passwordsCopy.footnote}</p>
    </>
  );
}
