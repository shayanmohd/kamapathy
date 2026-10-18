import type { RefObject } from "react";
import type { BrowserState } from "../../shared/types";
import { spaceButtonState } from "../lib/spaces";
import { spacesCopy } from "../copy";
import "./Spaces.css";

export function SpaceButton({
  state,
  now,
  seen,
  open,
  buttonRef,
  onClick,
}: {
  state: BrowserState;
  now: number;
  seen: ReadonlySet<string>;
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const view = spaceButtonState(state, now, seen);
  const current = state.spaces.find((space) => space.id === state.activeSpaceId);
  const label = spacesCopy.button(
    current?.name ?? "",
    view.working,
    view.needsYou,
    view.failed,
  );
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`space-trigger ${view.working ? "working" : ""} ${view.spinning ? "spinning" : ""}`}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
    >
      {view.working ? (
        <span className="space-trigger-count">{view.working}</span>
      ) : (
        <span className={`space-trigger-dot color-${view.color}`} />
      )}
      {(view.needsYou || view.failed) && (
        <span className="space-trigger-alert" />
      )}
    </button>
  );
}
