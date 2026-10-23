import type { RefObject } from "react";
import type {
  BrowserAction,
  BrowserState,
  UpdateCommand,
} from "../../shared/types";
import { aptInstallCommand } from "../../shared/state";
import { bridge } from "../lib/bridge";
import { agentSpacesLine, installSteps, updateLine } from "../lib/updateView";
import { updatesCopy as copy } from "../copy";
import { Modal } from "./ui";
import "./Updates.css";

// The updater answers with the new status and also sends it to the window, so
// a failed command leaves its reason in the status line.
const run = (command: UpdateCommand) => {
  void bridge.update(command).catch(() => {});
};

// Section 16's onboarding step 2 embeds this row on its own.
export function UpdateChecksSwitch({
  state,
  dispatch,
  buttonRef,
}: {
  state: BrowserState;
  dispatch: (action: BrowserAction) => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const on = state.settings.updateChecks;
  return (
    <div className="setting-row">
      <div>
        <strong>{copy.switch}</strong>
        <p>{copy.switchNote}</p>
      </div>
      <button
        ref={buttonRef}
        role="switch"
        aria-label={copy.switch}
        aria-checked={on}
        className={`toggle ${on ? "on" : ""}`}
        onClick={() =>
          dispatch({
            type: "settings:update",
            settings: { updateChecks: !on },
          })
        }
      >
        <span />
      </button>
    </div>
  );
}

export function UpdatesSection({
  state,
  dispatch,
  onInstall,
  onWhatsNew,
  switchRef,
}: {
  state: BrowserState;
  dispatch: (action: BrowserAction) => void;
  onInstall: () => void;
  onWhatsNew: () => void;
  switchRef?: RefObject<HTMLButtonElement | null>;
}) {
  const update = state.update;
  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h3 id="settings-updates">{copy.heading}</h3>
      <UpdateChecksSwitch
        state={state}
        dispatch={dispatch}
        buttonRef={switchRef}
      />
      <p className="update-status" role="status">
        {updateLine(update, state.version, Date.now())}
      </p>
      <div className="update-actions">
        {update.state !== "downloading" && update.state !== "unsupported" && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => run({ command: "check" })}
          >
            {copy.checkNow}
          </button>
        )}
        {update.state === "available" && (
          <button
            type="button"
            className="primary-button"
            onClick={() => run({ command: "download" })}
          >
            {copy.download}
          </button>
        )}
        {update.state === "downloading" && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => run({ command: "cancel" })}
          >
            {copy.cancel}
          </button>
        )}
        {update.state === "ready" && (
          <button type="button" className="primary-button" onClick={onInstall}>
            {copy.install}
          </button>
        )}
        {update.latest && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => run({ command: "notes", which: "latest" })}
          >
            {copy.releaseNotes}
          </button>
        )}
        <button type="button" className="secondary-button" onClick={onWhatsNew}>
          {copy.whatsNew}
        </button>
      </div>
    </section>
  );
}

export function InstallDialog({
  open,
  onClose,
  state,
}: {
  open: boolean;
  onClose: () => void;
  state: BrowserState;
}) {
  const update = state.update;
  const steps = installSteps(update.kind);
  const command =
    steps.command && update.installer
      ? aptInstallCommand(update.installer.path)
      : "";
  const spaces = agentSpacesLine(
    state.spaces.filter((space) => space.kind === "agent").length,
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.installTitle(update.latest?.version ?? state.version)}
      className="install-modal"
    >
      <p className="install-steps">{steps.steps}</p>
      {command && (
        <div className="install-command">
          <code>{command}</code>
          <button
            type="button"
            className="secondary-button"
            onClick={() => run({ command: "copy-command" })}
          >
            {copy.copyCommand}
          </button>
        </div>
      )}
      {spaces && <p className="install-spaces">{spaces}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>
          {copy.notNow}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() =>
            run(
              steps.primary === "install"
                ? { command: "install" }
                : { command: "show" },
            )
          }
        >
          {steps.primary === "install" ? copy.quitAndOpen : copy.showInFolder}
        </button>
      </div>
    </Modal>
  );
}
