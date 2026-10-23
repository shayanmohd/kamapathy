import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  MagnifyingGlass,
  Plus,
  Columns,
  ClockCounterClockwise,
  GearSix,
  BookmarkSimple,
  Stack,
  GlobeHemisphereWest,
  DownloadSimple,
  Camera,
  Code,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Password,
  SquaresFour,
  Robot,
  Question,
  Bug,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { BrowserState } from "../../shared/types";
import { HOME_URL } from "../../shared/state";
import { hostname } from "../../shared/url";
import { Modal, SiteIcon } from "./ui";
import { paletteActions, type ActionName } from "../lib/actions";
import { helpCopy } from "../copy";

type PaletteAction = (typeof paletteActions)[number];

// Each palette command, shown in the order of paletteActions.
const paletteCommands: Record<
  PaletteAction,
  { title: string; hint: string; icon: ReactNode }
> = {
  "new-tab": {
    title: "Open a new tab",
    hint: "New beginnings",
    icon: <Plus />,
  },
  split: {
    title: "Open split view",
    hint: "Two pages, one window",
    icon: <Columns />,
  },
  space: {
    title: "Create a space",
    hint: "Make room for a project",
    icon: <Stack />,
  },
  spaces: {
    title: "All spaces",
    hint: "See every space at once",
    icon: <SquaresFour />,
  },
  bookmarks: {
    title: "Your bookmarks",
    hint: "Keep the good stuff",
    icon: <BookmarkSimple />,
  },
  history: {
    title: "Browse history",
    hint: "Find your way back",
    icon: <ClockCounterClockwise />,
  },
  downloads: {
    title: "Downloads",
    hint: "Files you saved",
    icon: <DownloadSimple />,
  },
  settings: {
    title: "Settings",
    hint: "Make Kamapathy yours",
    icon: <GearSix />,
  },
  screenshot: {
    title: "Save page screenshot",
    hint: "Keep a picture of this page",
    icon: <Camera />,
  },
  devtools: {
    title: "Developer tools",
    hint: "Inspect this page",
    icon: <Code />,
  },
  "zoom-in": {
    title: "Zoom in",
    hint: "Make this page larger",
    icon: <MagnifyingGlassPlus />,
  },
  "zoom-out": {
    title: "Zoom out",
    hint: "Make this page smaller",
    icon: <MagnifyingGlassMinus />,
  },
  "zoom-reset": {
    title: "Reset zoom",
    hint: "Show this page at its usual size",
    icon: <MagnifyingGlass />,
  },
  "agent-setup": { ...helpCopy["agent-setup"], icon: <Robot /> },
  help: { ...helpCopy.help, icon: <Question /> },
  "report-issue": { ...helpCopy["report-issue"], icon: <Bug /> },
  privacy: { ...helpCopy.privacy, icon: <ShieldCheck /> },
};
const commands = paletteActions.map((id) => ({ id, ...paletteCommands[id] }));

interface Props {
  open: boolean;
  onClose: () => void;
  state: BrowserState;
  onNavigate: (url: string) => void;
  onTab: (id: string) => void;
  onAction: (action: ActionName) => void;
}
export function CommandPalette({
  open,
  onClose,
  state,
  onNavigate,
  onTab,
  onAction,
}: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);
  const commands = useMemo<
    { id: ActionName; title: string; hint: string; icon: ReactNode }[]
  >(
    () => [
      {
        id: "new-tab",
        title: "Open a new tab",
        hint: "New beginnings",
        icon: <Plus />,
      },
      {
        id: "split",
        title: "Open split view",
        hint: "Two pages, one window",
        icon: <Columns />,
      },
      {
        id: "space",
        title: "Create a space",
        hint: "Make room for a project",
        icon: <Stack />,
      },
      {
        id: "spaces",
        title: "All spaces",
        hint: "See every space at once",
        icon: <SquaresFour />,
      },
      {
        id: "bookmarks",
        title: "Your bookmarks",
        hint: "Keep the good stuff",
        icon: <BookmarkSimple />,
      },
      {
        id: "history",
        title: "Browse history",
        hint: "Find your way back",
        icon: <ClockCounterClockwise />,
      },
      {
        id: "downloads",
        title: "Downloads",
        hint: "Files you saved",
        icon: <DownloadSimple />,
      },
      {
        id: "passwords",
        title: "Passwords",
        hint: "Your saved sign-ins",
        icon: <Password />,
      },
      {
        id: "settings",
        title: "Settings",
        hint: "Make Kamapathy yours",
        icon: <GearSix />,
      },
      {
        id: "screenshot",
        title: "Save page screenshot",
        hint: "Keep a picture of this page",
        icon: <Camera />,
      },
      {
        id: "devtools",
        title: "Developer tools",
        hint: "Inspect this page",
        icon: <Code />,
      },
      {
        id: "zoom-in",
        title: "Zoom in",
        hint: "Make this page larger",
        icon: <MagnifyingGlassPlus />,
      },
      {
        id: "zoom-out",
        title: "Zoom out",
        hint: "Make this page smaller",
        icon: <MagnifyingGlassMinus />,
      },
      {
        id: "zoom-reset",
        title: "Reset zoom",
        hint: "Show this page at its usual size",
        icon: <MagnifyingGlass />,
      },
    ],
    [],
  );
  const needle = query.trim().toLowerCase();
  const items = [
    ...(needle
      ? [
          {
            key: "navigate",
            title: query,
            hint: "Search or go to website",
            icon: <GlobeHemisphereWest />,
            run: () => onNavigate(query),
          },
        ]
      : []),
    ...state.tabs
      .filter(
        (tab) =>
          tab.url !== HOME_URL &&
          (!needle || `${tab.title} ${tab.url}`.toLowerCase().includes(needle)),
      )
      .slice(0, 4)
      .map((tab) => ({
        key: tab.id,
        title: tab.title,
        hint: `Switch tab in ${state.spaces.find((space) => space.id === tab.spaceId)?.name}`,
        icon: <SiteIcon url={tab.url} />,
        run: () => onTab(tab.id),
      })),
    ...state.bookmarks
      .filter(
        (bookmark) =>
          needle &&
          `${bookmark.title} ${bookmark.url}`.toLowerCase().includes(needle),
      )
      .slice(0, 3)
      .map((bookmark) => ({
        key: bookmark.id,
        title: bookmark.title,
        hint: hostname(bookmark.url),
        icon: <SiteIcon url={bookmark.url} />,
        run: () => onNavigate(bookmark.url),
      })),
    ...commands
      .filter(
        (command) =>
          !needle ||
          `${command.title} ${command.hint}`.toLowerCase().includes(needle),
      )
      .map((command) => ({
        key: command.id,
        ...command,
        run: () => onAction(command.id),
      })),
  ];
  const index = Math.min(selected, Math.max(items.length - 1, 0));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Find your next direction"
      description="Search the web, switch tabs, or run a command."
      className="command-modal"
    >
      <div className="command-search">
        <MagnifyingGlass size={23} />
        <input
          autoFocus
          aria-label="Search tabs and commands"
          role="combobox"
          aria-controls="command-results"
          aria-expanded="true"
          aria-activedescendant={`command-${items[index]?.key}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          placeholder="Where would you like to go?"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(
                (current) =>
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length,
              );
            }
            if (event.key === "Enter" && items[index]) {
              event.preventDefault();
              onClose();
              items[index].run();
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="command-section-label">
        {needle ? "Results" : "Jump to"}
      </div>
      <div
        className="command-results"
        id="command-results"
        role="listbox"
        aria-label="Commands"
      >
        {items.map((item, itemIndex) => (
          <button
            id={`command-${item.key}`}
            role="option"
            aria-selected={itemIndex === index}
            className={itemIndex === index ? "selected" : ""}
            key={item.key}
            onPointerMove={() => setSelected(itemIndex)}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span className="command-icon">{item.icon}</span>
            <span>
              <strong>{item.title}</strong>
              <small>{item.hint}</small>
            </span>
            {itemIndex === index && <ArrowRight size={18} />}
          </button>
        ))}
      </div>
      <div className="command-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to navigate
        </span>
        <span>
          <kbd>↵</kbd> to open
        </span>
        <span>Made for your keyboard</span>
      </div>
    </Modal>
  );
}
