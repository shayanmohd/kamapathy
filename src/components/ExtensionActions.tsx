import { useLayoutEffect, useRef, type RefObject } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import {
  MAX_PINNED,
  type ExtensionAction,
  type ExtensionAnchor,
  type ExtensionCommand,
  type ExtensionsView,
} from "../../shared/extensions";
import { extensionsCopy } from "../copy";
import { Popover } from "./Popover";
import { IconButton } from "./ui";

function anchorOf(element: Element): ExtensionAnchor {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function ActionFace({ action }: { action: ExtensionAction }) {
  return (
    <>
      {action.icon ? (
        <img src={action.icon} alt="" width={16} height={16} />
      ) : (
        <span className="extension-letter" aria-hidden="true">
          {action.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {action.badge && (
        <span
          className="extension-badge"
          aria-hidden="true"
          style={{
            background: action.badgeColor,
            ...(action.badgeTextColor ? { color: action.badgeTextColor } : {}),
          }}
        >
          {action.badge}
        </span>
      )}
    </>
  );
}

// The person's extension buttons, between the address bar and the browser
// menu: the pinned ones, then the puzzle button and its menu.
export function ExtensionActions({
  view,
  puzzleRef,
  menuOpen,
  onCommand,
  onMenu,
  onCloseMenu,
  onManage,
}: {
  view: ExtensionsView;
  puzzleRef: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  onCommand: (command: ExtensionCommand) => void;
  onMenu: () => void;
  onCloseMenu: () => void;
  onManage: () => void;
}) {
  const pinned = view.actions
    .filter((action) => action.pinned)
    .slice(0, MAX_PINNED);
  const row = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const sent = useRef("");
  const report = useRef(() => {});
  const disabledLabel = view.disabled
    ? view.disabled === "isolated"
      ? extensionsCopy.isolated
      : extensionsCopy.agent
    : "";
  // Popups open under their button, so main is told where they are drawn.
  report.current = () => {
    const anchors: Record<string, ExtensionAnchor> = {};
    for (const action of pinned) {
      const element = buttons.current.get(action.id);
      if (element?.isConnected) anchors[action.id] = anchorOf(element);
    }
    const puzzle = puzzleRef.current ? anchorOf(puzzleRef.current) : null;
    const next = JSON.stringify([anchors, puzzle]);
    if (next === sent.current) return;
    sent.current = next;
    onCommand({ type: "anchors", buttons: anchors, puzzle });
  };
  useLayoutEffect(() => {
    const send = () => report.current();
    send();
    const observer = new ResizeObserver(send);
    if (row.current) observer.observe(row.current);
    if (row.current?.parentElement) observer.observe(row.current.parentElement);
    window.addEventListener("resize", send);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", send);
    };
  }, []);
  useLayoutEffect(() => report.current());

  if (!view.rows.length) return null;
  return (
    <div className="extension-actions" ref={row}>
      {pinned.map((action) => (
        <IconButton
          key={action.id}
          ref={(element) => {
            if (element) buttons.current.set(action.id, element);
            else buttons.current.delete(action.id);
          }}
          className="extension-button"
          label={disabledLabel || action.title || action.name}
          disabled={Boolean(view.disabled) || !action.enabled}
          onClick={(event) =>
            onCommand({
              type: "click",
              id: action.id,
              anchor: anchorOf(event.currentTarget),
            })
          }
        >
          <ActionFace action={action} />
        </IconButton>
      ))}
      <IconButton
        ref={puzzleRef}
        label={extensionsCopy.puzzle}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        <PuzzlePiece size={17} />
      </IconButton>
      <Popover
        open={menuOpen}
        onClose={onCloseMenu}
        anchor={puzzleRef}
        label={extensionsCopy.puzzle}
        align="end"
        className="extension-menu"
      >
        {view.disabled && (
          <p className="extension-menu-note">{disabledLabel}</p>
        )}
        {view.actions.map((action) => (
          <div className="extension-menu-row" key={action.id}>
            <button
              type="button"
              role="menuitem"
              disabled={Boolean(view.disabled) || !action.enabled}
              onClick={() => {
                onCloseMenu();
                onCommand({
                  type: "click",
                  id: action.id,
                  anchor: puzzleRef.current
                    ? anchorOf(puzzleRef.current)
                    : { x: 0, y: 0, width: 0, height: 0 },
                });
              }}
            >
              <ActionFace action={action} />
              <span>{action.name}</span>
            </button>
            <IconButton
              label={extensionsCopy.pin}
              className={action.pinned ? "is-pinned" : ""}
              aria-pressed={action.pinned}
              onClick={() =>
                onCommand({
                  type: "pin",
                  id: action.id,
                  pinned: !action.pinned,
                })
              }
            >
              <PuzzlePiece
                size={13}
                weight={action.pinned ? "fill" : "regular"}
              />
            </IconButton>
          </div>
        ))}
        <hr />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onCloseMenu();
            onManage();
          }}
        >
          <span>{extensionsCopy.manage}</span>
        </button>
      </Popover>
    </div>
  );
}
