import { useEffect, useId, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import type { AgentSetupStatus, BrowserState } from "../../shared/types";
import { bridge } from "../lib/bridge";
import {
  agentHint,
  initialChoices,
  nodeWarning,
  pathOption,
  setupRequest,
  type SetupChoices,
} from "../lib/setupView";
import { agentSetupCopy as copy } from "../copy";
import { Modal } from "./ui";
import "./AgentSetup.css";

type Platform = BrowserState["platform"];

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const toggled = (ids: string[], id: string, on: boolean) =>
  on
    ? [...ids.filter((item) => item !== id), id]
    : ids.filter((item) => item !== id);

function CopyLine({
  text,
  label,
  code = false,
  copied,
  onCopy,
}: {
  text: string;
  label: string;
  code?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="agent-setup-copy">
      {code ? <code>{text}</code> : <p>{text}</p>}
      <button type="button" className="secondary-button" onClick={onCopy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? copy.copied : label}
      </button>
    </div>
  );
}

// Section 16's onboarding embeds this panel, so it keeps its own intro and
// leaves through onSkip.
export function AgentSetupPanel({
  platform,
  onSkip,
  skipLabel,
  onChanged,
}: {
  platform: Platform;
  onSkip?: () => void;
  skipLabel?: string;
  onChanged?: (status: AgentSetupStatus) => void;
}) {
  const [status, setStatus] = useState<AgentSetupStatus | null>(null);
  const [choices, setChoices] = useState<SetupChoices | null>(null);
  const [busy, setBusy] = useState<"apply" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState("");
  const agentsId = useId();
  const tryId = useId();
  useEffect(() => {
    let alive = true;
    // The shell probe can take up to 5 seconds.
    bridge.agentSetupStatus({ probe: true }).then(
      (next) => {
        if (!alive) return;
        setStatus(next);
        setChoices(initialChoices(next, platform));
      },
      (caught) => {
        if (alive) setError(message(caught));
      },
    );
    return () => {
      alive = false;
    };
  }, [platform]);
  async function change(
    kind: "apply" | "remove",
    run: () => Promise<AgentSetupStatus>,
  ) {
    setBusy(kind);
    setError("");
    setDone(false);
    try {
      const next = await run();
      setStatus(next);
      setChoices(initialChoices(next, platform));
      setDone(kind === "apply");
      onChanged?.(next);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }
  // The main process writes the clipboard; the window never touches it.
  async function copyText(key: string, text: string) {
    setError("");
    try {
      await bridge.copyText(text);
      setCopied(key);
    } catch (caught) {
      setError(message(caught));
    }
  }
  const leave = onSkip && (
    <button
      type="button"
      className="secondary-button"
      disabled={!!busy}
      onClick={onSkip}
    >
      {skipLabel ?? copy.close}
    </button>
  );
  if (!status || !choices)
    return (
      <div className="agent-setup">
        <p className="agent-setup-intro">{copy.intro}</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="agent-setup-status" role="status">
            {copy.checking}
          </p>
        )}
        {leave && <div className="modal-actions">{leave}</div>}
      </div>
    );
  if (!status.supported)
    return (
      <div className="agent-setup">
        <p className="info-note">
          {status.reason === "test_profile"
            ? copy.testProfile
            : copy.desktopOnly}
        </p>
        {leave && <div className="modal-actions">{leave}</div>}
      </div>
    );
  const option = pathOption(status, platform);
  const warning = nodeWarning(status.node);
  const folder = status.skillFolder;
  const hints = [
    ...new Set(
      status.agents
        .filter((agent) => agent.state === "linked")
        .map((agent) => agentHint(agent.id)),
    ),
  ];
  const set = (next: Partial<SetupChoices>) =>
    setChoices({ ...choices, ...next });
  return (
    <form
      className="agent-setup"
      onSubmit={(event) => {
        event.preventDefault();
        void change("apply", () =>
          bridge.applyAgentSetup(setupRequest(choices, status, platform)),
        );
      }}
    >
      <p className="agent-setup-intro">{copy.intro}</p>
      <h3 id={agentsId} className="agent-setup-heading">
        {copy.agentsHeading}
      </h3>
      {status.agents.length ? (
        <ul className="agent-setup-agents" aria-labelledby={agentsId}>
          {status.agents.map((agent) => {
            const checked = choices.agents.includes(agent.id);
            return (
              <li key={agent.id} className="agent-setup-option">
                <label className="agent-setup-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!!busy}
                    onChange={(event) =>
                      set({
                        agents: toggled(
                          choices.agents,
                          agent.id,
                          event.target.checked,
                        ),
                      })
                    }
                  />
                  {agent.name}
                </label>
                {agent.state === "own_copy" && (
                  <div className="agent-setup-sub agent-setup-own">
                    <span>{copy.ownCopy}</span>
                    <label className="agent-setup-check">
                      <input
                        type="checkbox"
                        checked={checked && choices.replace.includes(agent.id)}
                        disabled={!!busy || !checked}
                        onChange={(event) =>
                          set({
                            replace: toggled(
                              choices.replace,
                              agent.id,
                              event.target.checked,
                            ),
                          })
                        }
                      />
                      {copy.useOurs}
                    </label>
                  </div>
                )}
                {agent.reason && (
                  <p className="agent-setup-sub agent-setup-reason">
                    {copy.reasons[agent.reason]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="agent-setup-status">{copy.noAgents}</p>
      )}
      <div className="agent-setup-option agent-setup-group">
        <label className="agent-setup-check">
          <input
            type="checkbox"
            checked={choices.command}
            disabled={!!busy}
            onChange={(event) => set({ command: event.target.checked })}
          />
          {copy.command}
        </label>
        {option && option.kind !== "manual" && (
          <label className="agent-setup-check agent-setup-sub">
            <input
              type="checkbox"
              checked={choices.command && choices.path}
              disabled={!!busy || !choices.command}
              onChange={(event) => set({ path: event.target.checked })}
            />
            {option.kind === "profile"
              ? copy.pathIn(option.file)
              : copy.pathWindows}
          </label>
        )}
        {option?.kind === "manual" && choices.command && (
          <div className="agent-setup-sub">
            <p className="agent-setup-note">{copy.pathManual}</p>
            <CopyLine
              text={option.line}
              label={copy.copy}
              code
              copied={copied === "line"}
              onCopy={() => void copyText("line", option.line)}
            />
          </div>
        )}
        {status.command.reason && (
          <p className="agent-setup-sub agent-setup-reason">
            {copy.reasons[status.command.reason]}
          </p>
        )}
        {warning && (
          <p className="agent-setup-sub agent-setup-reason">
            {warning === "node_missing"
              ? copy.nodeMissing
              : copy.nodeTooOld(status.node?.version ?? "")}
          </p>
        )}
      </div>
      {status.codex.detected && (
        <div className="agent-setup-option agent-setup-group">
          <label className="agent-setup-check">
            <input
              type="checkbox"
              checked={choices.codexRule}
              disabled={!!busy}
              onChange={(event) => set({ codexRule: event.target.checked })}
            />
            {copy.codexRule}
          </label>
          <p className="agent-setup-sub agent-setup-note">
            {copy.codexWarning}
          </p>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="agent-setup-done" role="status">
          <Check size={16} />
          {copy.done}
        </p>
      )}
      {folder && (
        <section className="agent-setup-try" aria-labelledby={tryId}>
          <h3 id={tryId} className="agent-setup-heading">
            {copy.tryIt}
          </h3>
          <CopyLine
            text={copy.firstPrompt}
            label={copy.copy}
            copied={copied === "prompt"}
            onCopy={() => void copyText("prompt", copy.firstPrompt)}
          />
          {hints.map((hint) => (
            <p key={hint} className="agent-setup-note">
              {hint}
            </p>
          ))}
          <p className="agent-setup-note">{copy.skillFolder}</p>
          <CopyLine
            text={folder}
            label={copy.copyPath}
            code
            copied={copied === "folder"}
            onCopy={() => void copyText("folder", folder)}
          />
        </section>
      )}
      <div className="modal-actions">
        {folder && (
          <button
            type="button"
            className="secondary-button agent-setup-remove"
            disabled={!!busy}
            onClick={() =>
              void change("remove", () => bridge.removeAgentSetup())
            }
          >
            {busy === "remove" ? copy.working : copy.remove}
          </button>
        )}
        {leave}
        <button type="submit" className="primary-button" disabled={!!busy}>
          {busy === "apply" ? copy.working : copy.setUp}
        </button>
      </div>
    </form>
  );
}

export function AgentSetupDialog({
  open,
  onClose,
  platform,
}: {
  open: boolean;
  onClose: () => void;
  platform: Platform;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      className="agent-setup-modal"
    >
      {open && <AgentSetupPanel platform={platform} onSkip={onClose} />}
    </Modal>
  );
}
