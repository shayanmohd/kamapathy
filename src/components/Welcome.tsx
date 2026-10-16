import { useEffect, useState } from "react";
import { ArrowRight, Check, DownloadSimple } from "@phosphor-icons/react";
import type {
  BrowserState,
  ImportOutcome,
  ImportSource,
} from "../../shared/types";
import { topSites } from "../../shared/topsites";
import { bridge } from "../lib/bridge";
import { importCopy, welcomeCopy } from "../copy";
import { Modal, SiteIcon } from "./ui";
import "./Welcome.css";

export function ImportPanel({
  onDone,
  onSkip,
}: {
  onDone: (outcome: ImportOutcome | null) => void;
  onSkip?: () => void;
}) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [source, setSource] = useState("");
  const [profile, setProfile] = useState("");
  const [bookmarks, setBookmarks] = useState(true);
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  useEffect(() => {
    let alive = true;
    bridge.importSources().then(
      (found) => {
        if (!alive) return;
        setSources(found);
        const first = found.find((item) => item.default) ?? found[0];
        if (first) {
          setSource(first.id);
          setProfile(first.profiles[0]?.id ?? "");
        }
      },
      () => {
        if (alive) setSources([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const chosen = sources?.find((item) => item.id === source);
  async function run() {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      const reply = await bridge.importBrowserData({
        profiles: [
          profile ? { source: chosen.id, profile } : { source: chosen.id },
        ],
        bookmarks,
        history,
        signIns: "none",
      });
      if ("error" in reply) setError(reply.error.message);
      else setOutcome(reply);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : importCopy.failed);
    } finally {
      setBusy(false);
    }
  }
  if (sources === null)
    return (
      <p className="import-status" role="status">
        {importCopy.looking}
      </p>
    );
  if (outcome)
    return (
      <div className="import-result" role="status">
        <p>
          <Check size={16} />
          {importCopy.done(outcome.bookmarks, outcome.history)}
        </p>
        {outcome.warnings.map((warning) => (
          <p key={warning} className="form-error">
            {warning}
          </p>
        ))}
        <div className="modal-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => onDone(outcome)}
          >
            {importCopy.continue} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    );
  if (!sources.length)
    return (
      <>
        <p className="info-note">{importCopy.none}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="primary-button"
            autoFocus
            onClick={() => onDone(null)}
          >
            {importCopy.continue} <ArrowRight size={16} />
          </button>
        </div>
      </>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <div
        className="import-sources"
        role="radiogroup"
        aria-label={importCopy.from}
      >
        {sources.map((item) => (
          <label
            key={item.id}
            className={`import-source ${item.id === source ? "selected" : ""}`}
          >
            <input
              type="radio"
              name="import-source"
              value={item.id}
              checked={item.id === source}
              onChange={() => {
                setSource(item.id);
                setProfile(item.profiles[0]?.id ?? "");
              }}
            />
            <span className="import-source-name">{item.name}</span>
            {item.default && (
              <span className="import-source-tag">
                {importCopy.defaultBrowser}
              </span>
            )}
          </label>
        ))}
      </div>
      {chosen && chosen.profiles.length > 1 && (
        <>
          <label className="field-label" htmlFor="import-profile">
            {importCopy.profile}
          </label>
          <select
            id="import-profile"
            className="text-input"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            {chosen.profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="import-choices">
        <label>
          <input
            type="checkbox"
            checked={bookmarks}
            onChange={(event) => setBookmarks(event.target.checked)}
          />
          {importCopy.bookmarks}
        </label>
        <label>
          <input
            type="checkbox"
            checked={history}
            onChange={(event) => setHistory(event.target.checked)}
          />
          {importCopy.history}
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        {onSkip && (
          <button
            type="button"
            className="secondary-button"
            onClick={onSkip}
            disabled={busy}
          >
            {importCopy.skip}
          </button>
        )}
        <button
          type="submit"
          className="primary-button"
          autoFocus
          disabled={busy || !chosen || (!bookmarks && !history)}
        >
          {busy ? importCopy.working : importCopy.import}
          <DownloadSimple size={16} />
        </button>
      </div>
    </form>
  );
}

export function Welcome({
  open,
  state,
  onOpenSite,
  onClose,
}: {
  open: boolean;
  state: BrowserState;
  onOpenSite: (url: string) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"import" | "sign-in">("import");
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const sites = topSites(state.history, state.bookmarks, 6);
  const importing = step === "import";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={importing ? welcomeCopy.title : welcomeCopy.signInTitle}
      description={
        importing ? welcomeCopy.description : welcomeCopy.signInDescription
      }
      className="welcome-modal"
      autoFocus={false}
    >
      {importing ? (
        <ImportPanel
          onDone={() => setStep("sign-in")}
          onSkip={() => setStep("sign-in")}
        />
      ) : (
        <>
          {sites.length ? (
            <div className="top-sites" aria-label={welcomeCopy.sites}>
              {sites.map((site) => {
                const done = opened.has(site.url);
                return (
                  <button
                    key={site.url}
                    type="button"
                    className={`top-site ${done ? "opened" : ""}`}
                    aria-pressed={done}
                    aria-label={`${welcomeCopy.open} ${site.title}`}
                    onClick={() => {
                      onOpenSite(site.url);
                      setOpened(new Set([...opened, site.url]));
                    }}
                  >
                    <span className="top-site-icon">
                      <SiteIcon url={site.url} size={22} />
                    </span>
                    <span className="top-site-name">{site.title}</span>
                    <span className="top-site-action">
                      {done ? welcomeCopy.opened : welcomeCopy.open}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="info-note">{welcomeCopy.noSites}</p>
          )}
          <div className="modal-actions">
            <button type="button" className="primary-button" onClick={onClose}>
              {welcomeCopy.done} <Check size={16} />
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
