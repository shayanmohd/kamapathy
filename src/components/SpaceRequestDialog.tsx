import { useEffect, useState } from "react";
import type { BrowserAction, BrowserState } from "../../shared/types";
import { spaceRequestCopy, spacesCopy } from "../copy";
import { Modal } from "./ui";
import "./Spaces.css";

// One agent request at a time, oldest first. The reason is the agent's own
// text, so it is shown as such and never as Kamapathy's words.
export function SpaceRequestDialog({
  open,
  state,
  onClose,
  attempt,
}: {
  open: boolean;
  state: BrowserState;
  onClose: () => void;
  attempt: (action: BrowserAction) => Promise<string>;
}) {
  const request = [...state.spaceRequests].sort((a, b) => a.at - b.at)[0];
  const choices = state.spaces.filter(
    (space) => space.kind === "personal" || space.access !== "granted",
  );
  const suggested =
    choices.find((space) => space.name === request?.name) ??
    choices.find((space) => space.id === state.activeSpaceId) ??
    choices[0];
  const [chosen, setChosen] = useState(suggested?.id ?? "");
  const [error, setError] = useState("");
  // Only a new request resets the choice.
  useEffect(() => {
    setChosen(suggested?.id ?? "");
    setError("");
  }, [request?.id]);
  async function answer(allow: boolean) {
    if (!request) return;
    setError(
      await attempt({
        type: "space-request:answer",
        id: request.id,
        allow,
        ...(allow ? { spaceId: chosen } : {}),
      }),
    );
  }
  return (
    <Modal
      open={open && !!request}
      onClose={onClose}
      title={spaceRequestCopy.title}
      className="space-request-dialog"
    >
      {request && (
        <>
          <p className="field-label">{spaceRequestCopy.from}</p>
          <p className="agent-text">{request.reason}</p>
          <p className="space-request-access">{spacesCopy.accessLine}</p>
          <div
            className="space-request-choices"
            role="radiogroup"
            aria-label={spacesCopy.menu}
          >
            {choices.map((space) => (
              <label key={space.id}>
                <input
                  type="radio"
                  name="space-request"
                  checked={chosen === space.id}
                  onChange={() => setChosen(space.id)}
                />
                <span className={`space-dot color-${space.color}`} />
                <span>{space.name}</span>
              </label>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void answer(false)}
            >
              {spaceRequestCopy.deny}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!chosen}
              onClick={() => void answer(true)}
            >
              {spaceRequestCopy.allow}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
