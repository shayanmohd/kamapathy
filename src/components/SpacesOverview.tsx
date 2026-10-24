import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import type {
  BrowserAction,
  BrowserState,
  Space,
  SpaceColor,
} from "../../shared/types";
import { openingTab } from "../../shared/state";
import { gridMove } from "../lib/navigation";
import { agentStatus, spaceColors, statusLine } from "../lib/spaces";
import { useEscape } from "../lib/useEscape";
import { overviewCopy, spacesCopy, statusCopy } from "../copy";
import { Favicon, IconButton } from "./ui";
import "./Spaces.css";
import "./SpacesOverview.css";

interface Props {
  state: BrowserState;
  now: number;
  seen: ReadonlySet<string>;
  thumbnails: Record<string, string>;
  dispatch: (action: BrowserAction) => Promise<boolean>;
  onClose: () => void;
}

export function SpacesOverview({ open, ...props }: Props & { open: boolean }) {
  return open ? <Overview {...props} /> : null;
}

function Overview({ state, now, seen, thumbnails, dispatch, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      state.spaces.findIndex((space) => space.id === state.activeSpaceId),
    ),
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const count = state.spaces.length + 1;
  const index = Math.min(selected, count - 1);
  const personalCount = state.spaces.filter(
    (space) => space.kind === "personal",
  ).length;
  useEscape(true, onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    grid.current?.querySelectorAll<HTMLElement>("[data-card]")[index]?.focus();
  }, [index]);
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      const focusable = [
        ...root.current!.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input",
        ),
      ].filter((element) => element.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    const columns = grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length
      : 1;
    const next = gridMove(index, count, columns, event.key);
    if (next === undefined) return;
    event.preventDefault();
    setSelected(next);
  }
  return (
    <div
      ref={root}
      className="spaces-overview"
      role="dialog"
      aria-modal="true"
      aria-label={overviewCopy.title}
      onKeyDown={keydown}
    >
      <header className="overview-header">
        <h2>{overviewCopy.count(state.spaces.length)}</h2>
        <IconButton label={overviewCopy.close} onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div ref={grid} className="overview-grid">
        {state.spaces.map((space, position) => {
          const status = agentStatus(space, state, now, seen);
          const tab =
            space.id === state.activeSpaceId
              ? state.tabs.find((item) => item.id === state.activeTabId)
              : openingTab(state, space.id);
          const canClose = space.kind === "agent" || personalCount > 1;
          const glow =
            status === "browsing" || status === "idle" || status === "error";
          const line = statusLine(space, now);
          return (
            <div
              key={space.id}
              className={`space-card ${space.id === state.activeSpaceId ? "current" : ""} ${glow ? "agent-glow" : ""}`}
            >
              <button
                type="button"
                data-card
                tabIndex={position === index ? 0 : -1}
                className="space-card-open"
                aria-label={overviewCopy.open(space.name)}
                onFocus={() => setSelected(position)}
                onClick={() => {
                  onClose();
                  void dispatch({ type: "space:activate", id: space.id });
                }}
              >
                {thumbnails[space.id] ? (
                  <img src={thumbnails[space.id]} alt="" />
                ) : (
                  tab && (
                    <span className="space-card-placeholder">
                      <Favicon tab={tab} size={20} />
                      <span>{tab.title}</span>
                    </span>
                  )
                )}
              </button>
              <div className="space-card-info">
                <span className={`space-dot color-${space.color}`} />
                {renaming === space.id ? (
                  <RenameField
                    space={space}
                    dispatch={dispatch}
                    onDone={() => setRenaming(null)}
                  />
                ) : (
                  <strong>{space.name}</strong>
                )}
                <span className="space-card-kind">
                  {space.kind === "agent" ? spacesCopy.agent : spacesCopy.personal}
                </span>
                {status && <span className="status-chip">{statusCopy[status]}</span>}
              </div>
              {line && (
                <p
                  className={
                    line.agent ? "status-line agent-text" : "status-line"
                  }
                >
                  {line.text}
                </p>
              )}
              <div className="space-card-actions">
                <IconButton
                  label={overviewCopy.rename(space.name)}
                  onClick={() => setRenaming(space.id)}
                >
                  <PencilSimple size={14} />
                </IconButton>
                <IconButton
                  label={
                    closing === space.id
                      ? overviewCopy.confirmClose(space.name)
                      : overviewCopy.closeSpace(space.name)
                  }
                  disabled={!canClose}
                  onClick={() =>
                    closing === space.id
                      ? void dispatch({ type: "space:delete", id: space.id })
                      : setClosing(space.id)
                  }
                >
                  <Trash size={14} />
                </IconButton>
              </div>
            </div>
          );
        })}
        <div className="space-card new">
          {creating ? (
            <NewSpaceForm
              dispatch={dispatch}
              onCreated={onClose}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <button
              type="button"
              data-card
              tabIndex={index === count - 1 ? 0 : -1}
              className="space-card-open"
              onFocus={() => setSelected(count - 1)}
              onClick={() => setCreating(true)}
            >
              <Plus size={22} />
              <span>{overviewCopy.newSpace}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RenameField({
  space,
  dispatch,
  onDone,
}: {
  space: Space;
  dispatch: (action: BrowserAction) => Promise<boolean>;
  onDone: () => void;
}) {
  const [name, setName] = useState(space.name);
  return (
    <form
      className="space-card-rename"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          !name.trim() ||
          (await dispatch({ type: "space:rename", id: space.id, name }))
        )
          onDone();
      }}
    >
      <input
        autoFocus
        aria-label={spacesCopy.nameLabel}
        maxLength={40}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }}
      />
    </form>
  );
}

function NewSpaceForm({
  dispatch,
  onCreated,
  onCancel,
}: {
  dispatch: (action: BrowserAction) => Promise<boolean>;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<SpaceColor>("green");
  return (
    <form
      className="new-space-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          name.trim() &&
          (await dispatch({ type: "space:create", name, color, kind: "personal" }))
        )
          onCreated();
      }}
    >
      <input
        autoFocus
        aria-label={spacesCopy.nameLabel}
        maxLength={40}
        placeholder={overviewCopy.placeholder}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      />
      <div className="space-colors" role="group" aria-label={spacesCopy.colour}>
        {spaceColors.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={`${option} space color`}
            aria-pressed={color === option}
            className={`color-swatch color-${option}`}
            onClick={() => setColor(option)}
          />
        ))}
      </div>
      <button type="submit" className="primary-button">
        {overviewCopy.create}
      </button>
    </form>
  );
}
