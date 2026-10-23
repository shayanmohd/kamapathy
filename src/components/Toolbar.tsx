import type { RefObject } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  DotsThree,
  X,
} from "@phosphor-icons/react";
import type { BrowserAction, Tab } from "../../shared/types";
import { Omnibox } from "./Omnibox";
import { IconButton } from "./ui";
import "./Toolbar.css";

export function Toolbar({
  tab,
  isHome,
  mac,
  agentOwned,
  bookmarked,
  dispatch,
  addressRef,
  onNavigate,
  onToggleBookmark,
  menuRef,
  menuOpen,
  menuDot,
  onMenu,
}: {
  tab: Tab | undefined;
  isHome: boolean;
  mac: boolean;
  agentOwned: boolean;
  bookmarked: boolean;
  dispatch: (action: BrowserAction) => void;
  addressRef: RefObject<HTMLInputElement | null>;
  onNavigate: (url: string) => void;
  onToggleBookmark: () => void;
  menuRef: RefObject<HTMLButtonElement | null>;
  menuOpen: boolean;
  menuDot: boolean;
  onMenu: () => void;
}) {
  return (
    <header className="toolbar">
      <IconButton
        label={`Go back (${mac ? "⌘ [" : "Alt+Left"})`}
        disabled={!tab?.canGoBack || agentOwned}
        onClick={() => tab && dispatch({ type: "tab:back", id: tab.id })}
      >
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton
        label="Go forward"
        disabled={!tab?.canGoForward || agentOwned}
        onClick={() => tab && dispatch({ type: "tab:forward", id: tab.id })}
      >
        <ArrowRight size={16} />
      </IconButton>
      <IconButton
        label={tab?.loading ? "Stop loading" : "Reload page"}
        disabled={isHome || agentOwned}
        onClick={() =>
          tab &&
          dispatch({ type: tab.loading ? "tab:stop" : "tab:reload", id: tab.id })
        }
      >
        {tab?.loading ? <X size={16} /> : <ArrowClockwise size={16} />}
      </IconButton>
      <Omnibox
        tab={tab}
        isHome={isHome}
        readOnly={agentOwned}
        inputRef={addressRef}
        bookmarked={bookmarked}
        onNavigate={onNavigate}
        onToggleBookmark={onToggleBookmark}
      />
      <IconButton
        ref={menuRef}
        className={menuDot ? "has-update" : ""}
        label="Browser menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        <DotsThree size={20} weight="bold" />
        {menuDot && <span className="menu-dot" aria-hidden="true" />}
      </IconButton>
    </header>
  );
}
