import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, Check, DownloadSimple } from "@phosphor-icons/react";
import type {
  BrowserState,
  DefaultBrowserStatus,
  ImportOutcome,
  ImportProfile,
  ImportReply,
  ImportSource,
} from "../../shared/types";
import { topSites } from "../../shared/topsites";
import { bridge } from "../lib/bridge";
import {
  blockedSources,
  doneLine,
  errorText,
  importRequest,
  initialSelection,
  SAFARI_FILE_LIMIT,
  selectableSource,
  signInsAvailable,
} from "../lib/import";
import {
  defaultBrowserChoice,
  nextStep,
  previousStep,
  stepNumber,
  type OnboardingStep,
} from "../lib/onboarding";
import { defaultBrowserCopy, importCopy, welcomeCopy } from "../copy";
import { Modal, SiteIcon } from "./ui";
import "./Welcome.css";

/** How often a blocked source is read again while the panel is open. */
const RECHECK_MS = 1500;

export function ImportPanel({
  onDone,
  onSkip,
  signIns: startSignIns = false,
}: {
  onDone: (outcome: ImportOutcome | null) => void;
  onSkip?: () => void;
  signIns?: boolean;
}) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [selection, setSelection] = useState<Map<string, Set<string>>>(
    () => new Map(),
  );
  const [bookmarks, setBookmarks] = useState(true);
  const [history, setHistory] = useState(true);
  const [signIns, setSignIns] = useState(startSignIns);
  const [destination, setDestination] = useState<"shared" | "separate">(
    "shared",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [withSignIns, setWithSignIns] = useState(false);
  const known = useRef<ImportSource[]>([]);
  const chooser = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    bridge.importSources().then(
      (found) => {
        if (!alive) return;
        known.current = found;
        setSources(found);
        setSelection(initialSelection(found));
      },
      () => {
        if (alive) setSources([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  // A source that was waiting for permission takes its first profile once it
  // becomes readable; everything the person chose stays as it is.
  const recheck = useCallback(() => {
    void bridge.importSources().then(
      (found) => {
        const freed = found.filter(
          (source) =>
            selectableSource(source) &&
            known.current.some(
              (before) =>
                before.id === source.id && before.status === "needs_permission",
            ),
        );
        known.current = found;
        setSources(found);
        if (!freed.length) return;
        setSelection((current) => {
          const next = new Map(current);
          for (const source of freed)
            if (!next.get(source.id)?.size)
              next.set(source.id, new Set([source.profiles[0].id]));
          return next;
        });
      },
      () => {},
    );
  }, []);
  const blocked = sources ? blockedSources(sources) : [];
  const watching = blocked.length > 0;
  useEffect(() => {
    if (!watching) return;
    window.addEventListener("focus", recheck);
    const timer = setInterval(recheck, RECHECK_MS);
    return () => {
      window.removeEventListener("focus", recheck);
      clearInterval(timer);
    };
  }, [watching, recheck]);
  // Safari is listed on macOS only, where the keychain asks for a password.
  const mac = (sources ?? []).some((source) => source.id === "safari");
  const canSignIns = sources ? signInsAvailable(sources, selection) : false;
  const request = importRequest({
    selection,
    bookmarks,
    history,
    signIns: signIns && canSignIns,
    destination,
  });
  function choose(source: string, profiles: Set<string>) {
    setSelection((current) => new Map(current).set(source, profiles));
  }
  function toggleProfile(
    source: ImportSource,
    profile: ImportProfile,
    on: boolean,
  ) {
    const profiles = new Set(selection.get(source.id) ?? []);
    if (on) profiles.add(profile.id);
    else profiles.delete(profile.id);
    choose(source.id, profiles);
  }
  function allChosen(source: ImportSource) {
    return (selection.get(source.id)?.size ?? 0) === source.profiles.length;
  }
  function toggleAll(source: ImportSource) {
    choose(
      source.id,
      new Set(allChosen(source) ? [] : source.profiles.map((item) => item.id)),
    );
  }
  async function send(call: () => Promise<ImportReply>, signInsSent: boolean) {
    setBusy(true);
    setError("");
    try {
      const reply = await call();
      if ("error" in reply) setError(errorText(reply.error));
      else {
        setWithSignIns(signInsSent);
        setOutcome(reply);
      }
    } catch {
      setError(importCopy.failed);
    } finally {
      setBusy(false);
    }
  }
  function run() {
    if (!request) return;
    void send(
      () => bridge.importBrowserData(request),
      request.signIns !== "none",
    );
  }
  // The Safari export carries no sign-ins.
  async function runSafari(file: File) {
    if (file.size > SAFARI_FILE_LIMIT) {
      setError(importCopy.tooLarge);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await send(
      () => bridge.importSafariArchive(bytes, { bookmarks, history }),
      false,
    );
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
          {doneLine(outcome, withSignIns)}
        </p>
        {outcome.spaces.length > 0 && (
          <p className="import-note">
            {importCopy.spaces(outcome.spaces.map((space) => space.name))}
          </p>
        )}
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
        run();
      }}
    >
      <div className="import-sources" role="group" aria-label={importCopy.from}>
        {sources
          .filter((source) => source.id !== "safari")
          .map((source) => {
            const tags = (
              <>
                {source.default && (
                  <span className="import-source-tag">
                    {importCopy.defaultBrowser}
                  </span>
                )}
                {source.status === "needs_permission" && (
                  <span className="import-source-tag">
                    {importCopy.needsPermission}
                  </span>
                )}
              </>
            );
            const only =
              source.profiles.length === 1 ? source.profiles[0] : undefined;
            if (only)
              return (
                <label key={source.id} className="import-source">
                  <span className="import-source-head">
                    <input
                      type="checkbox"
                      aria-label={source.name}
                      checked={selection.get(source.id)?.has(only.id) ?? false}
                      onChange={(event) =>
                        toggleProfile(source, only, event.target.checked)
                      }
                    />
                    <span className="import-source-name">{source.name}</span>
                    {tags}
                  </span>
                </label>
              );
            return (
              <div key={source.id} className="import-source">
                <div className="import-source-head">
                  <span className="import-source-name">{source.name}</span>
                  {tags}
                  {source.profiles.length > 1 && (
                    <button
                      type="button"
                      className="import-all"
                      aria-pressed={allChosen(source)}
                      onClick={() => toggleAll(source)}
                    >
                      {importCopy.allProfiles}
                    </button>
                  )}
                </div>
                {source.profiles.length > 1 && (
                  <div className="import-profiles">
                    {source.profiles.map((profile) => (
                      <label key={profile.id}>
                        <input
                          type="checkbox"
                          aria-label={`${source.name} ${profile.name}`}
                          checked={
                            selection.get(source.id)?.has(profile.id) ?? false
                          }
                          onChange={(event) =>
                            toggleProfile(source, profile, event.target.checked)
                          }
                        />
                        <span>{profile.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
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
        <label>
          <input
            type="checkbox"
            checked={signIns && canSignIns}
            disabled={!canSignIns}
            onChange={(event) => setSignIns(event.target.checked)}
          />
          {importCopy.signIns}
        </label>
      </div>
      {!canSignIns && <p className="import-note">{importCopy.signInsHint}</p>}
      {signIns && canSignIns && (
        <div
          className="import-destination"
          role="radiogroup"
          aria-label={importCopy.signIns}
        >
          <label>
            <input
              type="radio"
              name="import-destination"
              checked={destination === "shared"}
              onChange={() => setDestination("shared")}
            />
            {importCopy.sharedChoice}
          </label>
          <p className="import-note">{importCopy.sharedNote}</p>
          <label>
            <input
              type="radio"
              name="import-destination"
              checked={destination === "separate"}
              onChange={() => setDestination("separate")}
            />
            {importCopy.separateChoice}
          </label>
          <p className="import-note">{importCopy.separateNote}</p>
          {mac && <p className="import-note">{importCopy.keychainNote}</p>}
        </div>
      )}
      {watching && (
        <div className="import-permission" role="alert">
          <p>{importCopy.permission}</p>
          <p className="import-note">
            {blocked.map((source) => source.name).join(", ")}
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => bridge.openImportPermissions("full-disk")}
          >
            {importCopy.openSettings}
          </button>
        </div>
      )}
      {mac && (
        <div
          className="import-safari"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const dropped = event.dataTransfer.files[0];
            if (dropped) void runSafari(dropped);
          }}
        >
          <strong>{importCopy.safariTitle}</strong>
          <p className="import-note">{importCopy.safariSteps}</p>
          <input
            ref={chooser}
            type="file"
            className="import-file"
            accept=".zip,application/zip"
            aria-label={importCopy.chooseZip}
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (picked) void runSafari(picked);
            }}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => chooser.current?.click()}
          >
            {importCopy.chooseZip}
          </button>
          <p className="import-note">{importCopy.dropZip}</p>
        </div>
      )}
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
          disabled={busy || !request}
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
  defaultBrowser,
  onMakeDefault,
  updateSwitch,
  agentSetup,
}: {
  open: boolean;
  state: BrowserState;
  onOpenSite: (url: string) => void;
  onClose: () => void;
  defaultBrowser: DefaultBrowserStatus | null;
  onMakeDefault: () => void;
  updateSwitch?: ReactNode;
  agentSetup?: (next: () => void) => ReactNode;
}) {
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [makeDefault, setMakeDefault] = useState(false);
  const sites = topSites(state.history, state.bookmarks, 6);
  const choice = defaultBrowserChoice(defaultBrowser, state.platform);
  const back = previousStep(step);
  const next = () => setStep((current) => nextStep(current) ?? current);
  const headings: Record<OnboardingStep, [string, string?]> = {
    welcome: [welcomeCopy.title, welcomeCopy.description],
    privacy: [welcomeCopy.privacyTitle, welcomeCopy.privacy],
    import: [welcomeCopy.importTitle, welcomeCopy.importDescription],
    agents: [welcomeCopy.agentsTitle],
    "sign-in": [welcomeCopy.signInTitle, welcomeCopy.signInDescription],
    finish: [welcomeCopy.finishTitle, welcomeCopy.finish],
  };
  const [title, description] = headings[step];
  function finish() {
    if (makeDefault && choice.show) onMakeDefault();
    onClose();
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className="welcome-modal"
      autoFocus={false}
    >
      {step === "welcome" && (
        <div className="welcome-cards">
          <p>{welcomeCopy.spacesCard}</p>
          <p>{welcomeCopy.agentsCard}</p>
        </div>
      )}
      {step === "privacy" && updateSwitch}
      {step === "import" && <ImportPanel onDone={next} onSkip={next} />}
      {step === "agents" &&
        (agentSetup ? (
          agentSetup(next)
        ) : (
          <p className="info-note">{welcomeCopy.agentsElsewhere}</p>
        ))}
      {step === "sign-in" &&
        (sites.length ? (
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
        ))}
      {step === "finish" && choice.show && (
        <div className="welcome-default">
          <label>
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(event) => setMakeDefault(event.target.checked)}
            />
            {defaultBrowserCopy.choice}
          </label>
          {choice.note && <p className="import-note">{choice.note}</p>}
        </div>
      )}
      <p className="welcome-step">{welcomeCopy.step(stepNumber(step))}</p>
      <div className="modal-actions">
        {back && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => setStep(back)}
          >
            {welcomeCopy.back}
          </button>
        )}
        {step === "welcome" && (
          <button
            type="button"
            className="primary-button"
            autoFocus
            onClick={next}
          >
            {welcomeCopy.start} <ArrowRight size={16} />
          </button>
        )}
        {(step === "privacy" || step === "sign-in") && (
          <button type="button" className="primary-button" onClick={next}>
            {welcomeCopy.next} <ArrowRight size={16} />
          </button>
        )}
        {step === "agents" && !agentSetup && (
          <>
            <button type="button" className="secondary-button" onClick={next}>
              {welcomeCopy.agentsLater}
            </button>
            <button type="button" className="primary-button" onClick={next}>
              {welcomeCopy.next} <ArrowRight size={16} />
            </button>
          </>
        )}
        {step === "finish" && (
          <button type="button" className="primary-button" onClick={finish}>
            {welcomeCopy.startBrowsing} <Check size={16} />
          </button>
        )}
      </div>
    </Modal>
  );
}
