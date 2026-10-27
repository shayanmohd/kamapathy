import { useState } from "react";
import type { ClearSiteDataApproval, Space } from "../../shared/types";
import { clearDataCopy } from "../copy";
import "./PromptBar.css";

// An agent's request to clear one site's data, above the page it came from
// until the person answers or the request ends. Only Clear clears anything,
// so Don't clear has the focus.
export function ClearSiteDataBar({
  approval,
  space,
  onAnswer,
}: {
  approval: ClearSiteDataApproval;
  space: Space;
  onAnswer: (clear: boolean) => Promise<string>;
}) {
  const [error, setError] = useState("");
  // Cookies the person would lose sign out of their sites; anything else
  // only forgets settings.
  const cookies = approval.cookies?.count ? approval.cookies : undefined;
  async function answer(clear: boolean) {
    setError(await onAnswer(clear));
  }
  return (
    <section className="prompt-bar" role="region" aria-label={space.name}>
      <div className="prompt-bar-text" role="status">
        <strong>{clearDataCopy.title(new URL(approval.origin).host)}</strong>
        <p>
          {cookies
            ? clearDataCopy.cookies(
                clearDataCopy.what(
                  cookies.count,
                  !!approval.storage,
                  !!approval.cache,
                ),
                approval.origin,
                space.name,
                clearDataCopy.domains(cookies.domains),
              )
            : clearDataCopy.settings(approval.origin)}
        </p>
      </div>
      <div className="prompt-bar-actions">
        <button
          type="button"
          className="secondary-button"
          autoFocus
          onClick={() => void answer(false)}
        >
          {clearDataCopy.deny}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void answer(true)}
        >
          {clearDataCopy.clear}
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
