import { Fragment, useState } from "react";
import type {
  PasswordPrompt,
  PasswordPromptAnswer,
  PasswordResult,
} from "../../shared/types";
import { passwordsCopy } from "../copy";
import { isPasswordError } from "../lib/passwords";
import "./PromptBar.css";
import "./Passwords.css";

// The copy keeps the whole sentence, so the heading splits on this mark to
// show each host and username bidi-isolated.
const VALUE = "\u0000";

function heading(prompt: PasswordPrompt) {
  const copy = passwordsCopy.prompt;
  const values =
    prompt.kind === "update" ? [prompt.username, prompt.host] : [prompt.host];
  const text =
    prompt.kind === "update" ? copy.update(VALUE, VALUE) : copy.save(VALUE);
  return text.split(VALUE).map((part, index) => (
    <Fragment key={index}>
      {part}
      {values[index] !== undefined && <bdi>{values[index]}</bdi>}
    </Fragment>
  ));
}

/** The offer to save or update a password, in section 7's prompt bar slot. */
export function PasswordPromptBar({
  prompt,
  onAnswer,
}: {
  prompt: PasswordPrompt;
  onAnswer(answer: PasswordPromptAnswer): Promise<PasswordResult<{ ok: true }>>;
}) {
  // The edited username lives with the bar, and goes with the prompt.
  const [username, setUsername] = useState(prompt.username);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState("");
  const copy = passwordsCopy.prompt;
  const update = prompt.kind === "update";
  // An answered prompt leaves the state. A vault error keeps it and reads out.
  async function answer(given: PasswordPromptAnswer) {
    setAnswering(true);
    const result = await onAnswer(given);
    setAnswering(false);
    setError(isPasswordError(result) ? result.error.message : "");
  }
  return (
    <section
      className="prompt-bar password-prompt"
      role="region"
      aria-label={passwordsCopy.title}
    >
      <div className="prompt-bar-text" role="status">
        <strong>{heading(prompt)}</strong>
      </div>
      {!update && (
        <div className="prompt-bar-fields">
          <div className="prompt-bar-field">
            <label className="field-label" htmlFor="password-prompt-username">
              {copy.username}
            </label>
            <input
              id="password-prompt-username"
              className="text-input"
              dir="auto"
              maxLength={1000}
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <span className="password-prompt-dots">{copy.hidden}</span>
        </div>
      )}
      <div className="prompt-bar-actions">
        <button
          type="button"
          className="primary-button"
          disabled={answering}
          onClick={() =>
            void answer(
              update ? { action: "update" } : { action: "save", username },
            )
          }
        >
          {update ? copy.updateButton : copy.saveButton}
        </button>
        {!update && (
          <button
            type="button"
            className="secondary-button"
            disabled={answering}
            onClick={() => void answer({ action: "never" })}
          >
            {copy.never}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={answering}
          onClick={() => void answer({ action: "dismiss" })}
        >
          {copy.notNow}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
