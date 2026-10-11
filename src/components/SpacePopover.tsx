import { useState, type RefObject } from "react";
import {
  CaretRight,
  Check,
  DotsThree,
  LockSimple,
  PencilSimple,
  Plus,
  Trash,
  SquaresFour,
} from "@phosphor-icons/react";
import type { BrowserAction, BrowserState, Space } from "../../shared/types";
import type { ActionName } from "../lib/actions";
import { keyLabel } from "../lib/keys";
import {
  activityTime,
  agentStatus,
  spaceActivity,
  spaceColors,
  type AgentStatus,
} from "../lib/spaces";
import {
  agentBarCopy,
  overviewCopy,
  signInsCopy,
  spacesCopy,
  statusCopy,
} from "../copy";
import { Popover } from "./Popover";
import "./Spaces.css";

interface ListProps {
  state: BrowserState;
  now: number;
  seen: ReadonlySet<string>;
  dispatch: (action: BrowserAction) => Promise<boolean>;
  onClose: () => void;
  onAction: (name: ActionName) => void;
  onAgentSettings: () => void;
  onViewActivity: (spaceId: string) => void;
  onRequest: () => void;
  mac: boolean;
}

export function SpacePopover({
  open,
  anchor,
  ...props
}: ListProps & { open: boolean; anchor: RefObject<HTMLElement | null> }) {
  return (
    <Popover
      open={open}
      onClose={props.onClose}
      anchor={anchor}
      label={spacesCopy.menu}
      align="end"
      className="space-popover"
    >
      <SpaceList {...props} />
    </Popover>
  );
}

function SpaceList({
  state,
  now,
  seen,
  dispatch,
  onClose,
  onAction,
  onAgentSettings,
  onViewActivity,
  onRequest,
  mac,
}: ListProps) {
  const [details, setDetails] = useState<string | null>(null);
  const [options, setOptions] = useState<string | null>(null);
  const agents = state.spaces.filter((space) => space.kind === "agent");
  const personal = state.spaces.filter((space) => space.kind === "personal");
  const row = (space: Space) => (
    <SpaceRow
      key={space.id}
      space={space}
      state={state}
      status={agentStatus(space, state, now, seen)}
      showDetails={details === space.id}
      showOptions={options === space.id}
      canClose={space.kind === "agent" || personal.length > 1}
      dispatch={dispatch}
      onOpen={() => {
        onClose();
        void dispatch({ type: "space:activate", id: space.id });
      }}
      onDetails={() => setDetails(details === space.id ? null : space.id)}
      onOptions={() => setOptions(options === space.id ? null : space.id)}
      onViewActivity={() => {
        onClose();
        onViewActivity(space.id);
      }}
    />
  );
  return (
    <>
      {state.spaceRequests.length > 0 && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onRequest();
          }}
        >
          {spacesCopy.request}
        </button>
      )}
      {!state.settings.automationEnabled ? (
        <>
          <p className="popover-heading">{spacesCopy.agents}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onAgentSettings();
            }}
          >
            {spacesCopy.accessOff}
          </button>
        </>
      ) : (
        agents.length > 0 && (
          <>
            <p className="popover-heading">{spacesCopy.agents}</p>
            {agents.map(row)}
          </>
        )
      )}
      <p className="popover-heading">{spacesCopy.yours}</p>
      {personal.map(row)}
      <hr />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onAction("spaces");
        }}
      >
        <SquaresFour size={16} />
        <span>{overviewCopy.title}</span>
        <kbd aria-hidden="true">{keyLabel(mac, "alt+s")}</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onAction("space");
        }}
      >
        <Plus size={16} />
        <span>{spacesCopy.newSpace}</span>
      </button>
    </>
  );
}

function SpaceRow({
  space,
  state,
  status,
  showDetails,
  showOptions,
  canClose,
  dispatch,
  onOpen,
  onDetails,
  onOptions,
  onViewActivity,
}: {
  space: Space;
  state: BrowserState;
  status: AgentStatus | undefined;
  showDetails: boolean;
  showOptions: boolean;
  canClose: boolean;
  dispatch: (action: BrowserAction) => Promise<boolean>;
  onOpen: () => void;
  onDetails: () => void;
  onOptions: () => void;
  onViewActivity: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(space.name);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmGrant, setConfirmGrant] = useState(false);
  const [confirmKeep, setConfirmKeep] = useState(false);
  const granted = space.access === "granted";
  const current = space.id === state.activeSpaceId;
  const tabs = state.tabs.filter((tab) => tab.spaceId === space.id).length;
  return (
    <div className={`space-row ${current ? "current" : ""}`}>
      <div className="space-row-main">
        <button
          type="button"
          role="menuitem"
          className="space-row-open"
          aria-current={current || undefined}
          onClick={onOpen}
        >
          <span className={`space-dot color-${space.color} ${status ?? ""}`} />
          <span className="space-row-name">{space.name}</span>
          <span className="space-row-meta">
            {status ? statusCopy[status] : spacesCopy.tabs(tabs)}
          </span>
          {current && <Check size={14} />}
        </button>
        {status && (
          <button
            type="button"
            role="menuitem"
            className="space-row-icon space-row-details"
            aria-label={spacesCopy.details(space.name)}
            aria-expanded={showDetails}
            onClick={onDetails}
          >
            <CaretRight size={12} />
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className="space-row-icon"
          aria-label={spacesCopy.options(space.name)}
          aria-expanded={showOptions}
          onClick={onOptions}
        >
          <DotsThree size={14} weight="bold" />
        </button>
      </div>
      {showDetails && status && (
        <div className="space-row-panel">
          <ol className="activity-entries">
            {spaceActivity(state.activity, space.id)
              .slice(0, 5)
              .map((item) => (
                <li key={item.id}>
                  <span>{item.message}</span>
                  <time>{activityTime(item.time)}</time>
                </li>
              ))}
          </ol>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void dispatch({
                type: "space:ownership",
                id: space.id,
                owner: space.owner === "agent" ? "human" : "agent",
              })
            }
          >
            {space.owner === "agent"
              ? agentBarCopy.takeOver
              : agentBarCopy.letContinue}
          </button>
          {granted && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                void dispatch({ type: "space:stop", id: space.id })
              }
            >
              {agentBarCopy.stop}
            </button>
          )}
          <button type="button" role="menuitem" onClick={onViewActivity}>
            {spacesCopy.viewAll}
          </button>
        </div>
      )}
      {showOptions && (
        <div className="space-row-panel">
          {renaming ? (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (
                  name.trim() &&
                  (await dispatch({ type: "space:rename", id: space.id, name }))
                )
                  setRenaming(false);
              }}
            >
              <input
                className="space-rename"
                aria-label={spacesCopy.nameLabel}
                value={name}
                maxLength={40}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setName(space.name);
                setRenaming(true);
              }}
            >
              <PencilSimple size={14} />
              <span>{spacesCopy.rename}</span>
            </button>
          )}
          <div className="space-colors" role="group" aria-label={spacesCopy.colour}>
            {spaceColors.map((color) => (
              <button
                key={color}
                type="button"
                role="menuitemradio"
                aria-checked={space.color === color}
                aria-label={`${color} space color`}
                className={`color-swatch color-${color}`}
                onClick={() =>
                  void dispatch({ type: "space:color", id: space.id, color })
                }
              />
            ))}
          </div>
          {space.kind === "personal" &&
            (granted ? (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  void dispatch({ type: "space:stop", id: space.id })
                }
              >
                {spacesCopy.stopAccess}
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  confirmGrant
                    ? void dispatch({ type: "space:grant", id: space.id })
                    : setConfirmGrant(true)
                }
              >
                {spacesCopy.grant}
              </button>
            ))}
          {confirmGrant && !granted && (
            <p className="popover-warning">{spacesCopy.accessLine}</p>
          )}
          {space.kind === "agent" && space.access === "ended" && (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                space.signIns === "separate" && !confirmKeep
                  ? setConfirmKeep(true)
                  : void dispatch({ type: "space:keep", id: space.id })
              }
            >
              {agentBarCopy.keep}
            </button>
          )}
          {confirmKeep && (
            <p className="popover-warning">{agentBarCopy.keepWarning}</p>
          )}
          {space.kind === "personal" && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={space.signIns === "separate"}
              disabled={granted}
              onClick={() =>
                void dispatch({
                  type: "space:sign-ins",
                  id: space.id,
                  signIns: space.signIns === "separate" ? "shared" : "separate",
                })
              }
            >
              <LockSimple size={14} />
              <span>{signInsCopy.label}</span>
              {space.signIns === "separate" && <Check size={14} />}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={!canClose}
            onClick={() =>
              confirmClose
                ? void dispatch({ type: "space:delete", id: space.id })
                : setConfirmClose(true)
            }
          >
            <Trash size={14} />
            <span>{confirmClose ? spacesCopy.confirmClose : spacesCopy.close}</span>
          </button>
          {confirmClose && (
            <p className="popover-warning">{spacesCopy.closeWarning}</p>
          )}
        </div>
      )}
    </div>
  );
}
