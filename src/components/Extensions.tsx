import { useState } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import {
  type ExtensionCommand,
  type ExtensionRow,
  type ExtensionsView,
} from "../../shared/extensions";
import { extensionsCopy } from "../copy";
import { Modal } from "./ui";

function sourceLabel(row: ExtensionRow): string {
  if (row.importedFrom) return extensionsCopy.sourceImported(row.importedFrom);
  return row.source === "unpacked"
    ? extensionsCopy.sourceUnpacked
    : extensionsCopy.sourceStore;
}

function Row({
  row,
  developerMode,
  onCommand,
}: {
  row: ExtensionRow;
  developerMode: boolean;
  onCommand: (command: ExtensionCommand) => void;
}) {
  return (
    <li className="extension-row">
      <div className="extension-row-head">
        {row.icon ? (
          <img src={row.icon} alt="" width={24} height={24} />
        ) : (
          <PuzzlePiece size={22} />
        )}
        <div>
          <strong>{row.name}</strong>
          <p>
            {sourceLabel(row)} <span>{row.version}</span>
          </p>
        </div>
        <button
          role="switch"
          aria-label={extensionsCopy.turnOn(row.name)}
          aria-checked={row.enabled}
          className={`toggle ${row.enabled ? "on" : ""}`}
          disabled={row.needsDeveloperMode}
          title={
            row.needsDeveloperMode ? extensionsCopy.needsDeveloperMode : ""
          }
          onClick={() =>
            onCommand({
              type: "enable",
              id: row.id,
              enabled: !row.enabled,
            })
          }
        >
          <span />
        </button>
      </div>
      <details>
        <summary>{extensionsCopy.details(row.name)}</summary>
        {row.lines.length > 0 && (
          <>
            <h4>{extensionsCopy.can}</h4>
            <ul>
              {row.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {row.wontWork.length > 0 && (
          <>
            <h4>{extensionsCopy.wontWork}</h4>
            <ul>
              {row.wontWork.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </>
        )}
        {row.update?.state === "review" && (
          <p className="extension-update">
            {extensionsCopy.needsOk}
            <button
              type="button"
              className="secondary-button"
              onClick={() => onCommand({ type: "review", id: row.id })}
            >
              {extensionsCopy.review}
            </button>
          </p>
        )}
        {row.update?.state === "staged" && row.update.version && (
          <p className="extension-update">
            {extensionsCopy.staged(row.update.version)}
          </p>
        )}
        {row.update?.state === "failed" && (
          <p className="form-error">{extensionsCopy.updateFailed}</p>
        )}
        {row.error && <p className="form-error">{row.error}</p>}
        {row.needsDeveloperMode && (
          <p className="setting-note">{extensionsCopy.needsDeveloperMode}</p>
        )}
        <div className="extension-row-actions">
          <button
            type="button"
            className="secondary-button"
            aria-pressed={row.pinned}
            onClick={() =>
              onCommand({
                type: "pin",
                id: row.id,
                pinned: !row.pinned,
              })
            }
          >
            {extensionsCopy.pin}
          </button>
          {row.hasOptions && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onCommand({ type: "options", id: row.id })}
            >
              {extensionsCopy.options}
            </button>
          )}
          {row.source === "unpacked" && developerMode && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onCommand({ type: "reload", id: row.id })}
            >
              {extensionsCopy.reload}
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => onCommand({ type: "remove", id: row.id })}
          >
            {extensionsCopy.remove}
          </button>
        </div>
      </details>
    </li>
  );
}

// Everything the person does with their extensions: add one, see what each
// can do, turn it off, pin it, open its options or remove it.
export function Extensions({
  open,
  onClose,
  view,
  developerMode,
  desktop,
  onCommand,
}: {
  open: boolean;
  onClose: () => void;
  view: ExtensionsView;
  developerMode: boolean;
  desktop: boolean;
  onCommand: (command: ExtensionCommand) => Promise<string>;
}) {
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  // Every failure in here shows under the field, so nothing is lost.
  function run(command: ExtensionCommand): void {
    const adds = command.type === "install" || command.type === "load-unpacked";
    if (adds) setAdding(true);
    setError("");
    void onCommand(command).then((message) => {
      if (adds) setAdding(false);
      if (message) setError(message);
      else if (command.type === "install") setInput("");
    });
  }
  const busy = adding || view.installing.length > 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={extensionsCopy.title}
      className="extensions-modal"
    >
      <p className="info-note">{extensionsCopy.note}</p>
      <form
        className="extension-store"
        onSubmit={(event) => {
          event.preventDefault();
          run({ type: "install", input });
        }}
      >
        <input
          className="text-input"
          aria-label={extensionsCopy.storeLabel}
          placeholder={extensionsCopy.storePlaceholder}
          value={input}
          spellCheck={false}
          onChange={(event) => setInput(event.target.value)}
        />
        <button
          type="submit"
          className="primary-button"
          disabled={!desktop || busy || !input.trim()}
        >
          {busy ? extensionsCopy.adding : extensionsCopy.add}
        </button>
        {developerMode && (
          <button
            type="button"
            className="secondary-button"
            disabled={!desktop || busy}
            onClick={() => run({ type: "load-unpacked" })}
          >
            {extensionsCopy.loadUnpacked}
          </button>
        )}
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {view.rows.length ? (
        <ul className="extension-rows">
          {view.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              developerMode={developerMode}
              onCommand={run}
            />
          ))}
        </ul>
      ) : (
        <p className="setting-note">{extensionsCopy.empty}</p>
      )}
    </Modal>
  );
}
