import { useState } from "react";
import type { BrowserAction, Space } from "../../shared/types";
import type { AgentStatus } from "../lib/spaces";
import { agentBarCopy } from "../copy";
import "./AgentBar.css";

export function AgentBar({
  space,
  status,
  attempt,
}: {
  space: Space;
  status: AgentStatus;
  attempt: (action: BrowserAction) => Promise<string>;
}) {
  const [confirming, setConfirming] = useState<"stop" | "keep" | null>(null);
  const [error, setError] = useState("");
  async function run(action: BrowserAction) {
    setConfirming(null);
    setError(await attempt(action));
  }
  const keep = { type: "space:keep", id: space.id } as const;
  return (
    <div className="agent-bar" role="region" aria-label={space.name}>
      <span
        className={`agent-indicator ${status} color-${space.color}`}
        aria-hidden="true"
      />
      <span className="agent-bar-status" role="status">
        {space.name} · {agentBarCopy.status[status]}
      </span>
      {confirming === "stop" ? (
        <>
          <span className="agent-bar-question">{agentBarCopy.confirmStop}</span>
          <button
            type="button"
            className="agent-bar-danger"
            onClick={() => run({ type: "space:stop", id: space.id })}
          >
            {agentBarCopy.stop}
          </button>
          <button
            type="button"
            onClick={() =>
              run({
                type: "settings:update",
                settings: { automationEnabled: false },
              })
            }
          >
            {agentBarCopy.stopAll}
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            {agentBarCopy.cancel}
          </button>
        </>
      ) : confirming === "keep" ? (
        <>
          <span className="agent-bar-question">{agentBarCopy.keepWarning}</span>
          <button type="button" onClick={() => run(keep)}>
            {agentBarCopy.keep}
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            {agentBarCopy.cancel}
          </button>
        </>
      ) : (
        <>
          {space.owner === "agent" ? (
            <button
              type="button"
              onClick={() =>
                run({ type: "space:ownership", id: space.id, owner: "human" })
              }
            >
              {agentBarCopy.takeOver}
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                run({ type: "space:ownership", id: space.id, owner: "agent" })
              }
            >
              {agentBarCopy.letContinue}
            </button>
          )}
          {space.access === "granted" && status !== "paused" && (
            <button type="button" onClick={() => setConfirming("stop")}>
              {agentBarCopy.stop}
            </button>
          )}
          {space.kind === "agent" && space.access === "ended" && (
            <button
              type="button"
              onClick={() =>
                space.signIns === "separate" ? setConfirming("keep") : run(keep)
              }
            >
              {agentBarCopy.keep}
            </button>
          )}
        </>
      )}
      {error && (
        <p className="agent-bar-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
