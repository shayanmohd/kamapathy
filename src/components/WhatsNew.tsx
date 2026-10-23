import type { ReleaseNote } from "../whats-new";
import { whatsNewCopy as copy } from "../copy";
import { bridge } from "../lib/bridge";
import { Modal } from "./ui";
import "./Updates.css";

export function WhatsNewDialog({
  open,
  notes,
  version,
  onClose,
}: {
  open: boolean;
  notes: readonly ReleaseNote[];
  version: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title(version)}
      className="whats-new-modal"
    >
      {notes.map((note) => (
        <section key={note.version} className="whats-new-release">
          <h3>
            {note.headline}
            <span>{note.version}</span>
          </h3>
          <ul>
            {note.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          {note.agents?.length ? (
            <>
              <h4>{copy.agents}</h4>
              <ul>
                {note.agents.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
          {note.steps?.length ? (
            <>
              <h4>{copy.steps}</h4>
              <ul>
                {note.steps.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ))}
      <div className="modal-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            void bridge
              .update({ command: "notes", which: "running" })
              .catch(() => {});
          }}
        >
          {copy.releaseNotes}
        </button>
        <button type="button" className="primary-button" onClick={onClose}>
          {copy.gotIt}
        </button>
      </div>
    </Modal>
  );
}
