import type { ReactNode, RefObject } from "react";
import {
  BookmarkSimple,
  ClockCounterClockwise,
  Columns,
  Command,
  DownloadSimple,
  GearSix,
  MagnifyingGlass,
  Plus,
  PuzzlePiece,
  Stack,
} from "@phosphor-icons/react";
import {
  toolsMenuLayout,
  type ActionName,
  type ToolsMenuAction,
} from "../lib/actions";
import { keyLabel } from "../lib/keys";
import { toolsMenuCopy } from "../copy";
import { Popover } from "./Popover";

const icons: Record<ToolsMenuAction, ReactNode> = {
  "new-tab": <Plus size={16} />,
  space: <Stack size={16} />,
  command: <Command size={16} />,
  bookmarks: <BookmarkSimple size={16} />,
  history: <ClockCounterClockwise size={16} />,
  downloads: <DownloadSimple size={16} />,
  extensions: <PuzzlePiece size={16} />,
  split: <Columns size={16} />,
  find: <MagnifyingGlass size={16} />,
  settings: <GearSix size={16} />,
};
const keys: Partial<Record<ToolsMenuAction, string>> = {
  "new-tab": "mod+t",
  command: "mod+k",
  bookmarks: "mod+shift+b",
  history: "mod+y",
  downloads: "mod+shift+j",
  find: "mod+f",
  settings: "mod+,",
};

export function ToolsMenu({
  open,
  onClose,
  anchor,
  mac,
  isHome,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  mac: boolean;
  isHome: boolean;
  onAction: (name: ActionName) => void;
}) {
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      label={toolsMenuCopy.label}
      align="end"
      className="tools-menu"
    >
      {toolsMenuLayout.map((id, index) => {
        if (id === null) return <hr key={`divider-${index}`} />;
        const combo = id === "history" && !mac ? "mod+h" : keys[id];
        return (
          <button
            key={id}
            type="button"
            role="menuitem"
            disabled={id === "find" && isHome}
            onClick={() => {
              onClose();
              onAction(id);
            }}
          >
            {icons[id]}
            <span>{toolsMenuCopy[id]}</span>
            {combo && <kbd aria-hidden="true">{keyLabel(mac, combo)}</kbd>}
          </button>
        );
      })}
    </Popover>
  );
}
