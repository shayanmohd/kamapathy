import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  X,
  Plus,
  LockSimple,
  GlobeHemisphereWest,
  BookmarkSimple,
  Columns,
  ArrowSquareOut,
  ArrowUpRight,
  PushPin,
  Copy,
  WarningCircle,
  Check,
  Info,
} from "@phosphor-icons/react";
import type {
  Bookmark,
  BrowserAction,
  BrowserState,
  FrozenFrame,
  SignIns,
  SpaceColor,
} from "../shared/types";
import { agentRules, HOME_URL, initialState } from "../shared/state";
import { fileKind, hostname, isGoogleSignInRejectedUrl } from "../shared/url";
import { bridge, isDesktop } from "./lib/bridge";
import { decodeFrames, Freezer, nextPaint } from "./lib/freeze";
import { IconButton, Modal, SiteIcon } from "./components/ui";
import { NewTab } from "./components/NewTab";
import { CommandPalette } from "./components/CommandPalette";
import { Settings } from "./components/Settings";
import { LibraryDialog } from "./components/Library";
import { ToolsMenu } from "./components/ToolsMenu";
import { TabStrip } from "./components/TabStrip";
import { Toolbar } from "./components/Toolbar";
import { AgentBar } from "./components/AgentBar";
import { acknowledgeHandoff, agentStatus } from "./lib/spaces";
import { SpaceButton } from "./components/SpaceButton";
import { SpacePopover } from "./components/SpacePopover";
import { SpaceRequestDialog } from "./components/SpaceRequestDialog";
import { ActivityDialog } from "./components/ActivityDialog";
import { SpacesOverview } from "./components/SpacesOverview";
import { FindPill } from "./components/FindPill";
import { ImportPanel, Welcome } from "./components/Welcome";
import {
  fileCopy,
  importCopy,
  newTabCopy,
  signInNoticeCopy,
  signInsCopy,
  spacesCopy,
} from "./copy";
import { signInNotice } from "./lib/sign-in-notice";
import { useDefaultBrowser } from "./lib/useDefaultBrowser";
import { useAgentClock } from "./lib/useAgentClock";
import { spaceTabs } from "./lib/tabs";
import { type ActionName, isActionName } from "./lib/actions";
import { keyAction } from "./lib/keys";

type Overlay =
  | "command"
  | "settings"
  | "space"
  | "bookmark"
  | "split"
  | "tab-menu"
  | "menu"
  | "bookmarks"
  | "history"
  | "downloads"
  | "tab-search"
  | "space-popover"
  | "activity"
  | "spaces-grid"
  | "welcome"
  | "import"
  | "space-request";
export default function App() {
  const [state, setState] = useState<BrowserState>(() => initialState());
  const [ready, setReady] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [frames, setFrames] = useState<FrozenFrame[]>([]);
  const [freezer] = useState(
    () => new Freezer({ bridge, decode: decodeFrames, painted: nextPaint }),
  );
  const [toast, setToast] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [spaceName, setSpaceName] = useState("");
  const [spaceKind, setSpaceKind] = useState<"personal" | "agent">("personal");
  const [spaceColor, setSpaceColor] = useState<SpaceColor>("green");
  const [spaceSignIns, setSpaceSignIns] = useState<SignIns>("shared");
  const [bookmarkTitle, setBookmarkTitle] = useState("");
  const [bookmarkUrl, setBookmarkUrl] = useState("");
  const [editingBookmark, setEditingBookmark] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState("");
  const [formError, setFormError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<Overlay | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const now = useAgentClock(state.activity);
  const [seenHandoffs, setSeenHandoffs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The open space counts as seen in this very render, so no mark flashes.
  const seen = acknowledgeHandoff(
    seenHandoffs,
    state.activity,
    state.activeSpaceId,
  );
  const [activitySpaceId, setActivitySpaceId] = useState("");
  const spaceTrigger = useRef<HTMLButtonElement>(null);
  const active =
    state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
  const activeSpace =
    state.spaces.find((space) => space.id === state.activeSpaceId) ||
    state.spaces[0];
  const splitTab = state.tabs.find((tab) => tab.id === state.splitTabId);
  const isHome = !active || active.url === HOME_URL;
  const googleSignInRejected =
    isDesktop && !!active && isGoogleSignInRejectedUrl(active.url);
  // The notice and the welcome's last step each read the default browser.
  const noticeDefault = useDefaultBrowser(googleSignInRejected);
  const welcomeDefault = useDefaultBrowser(overlay === "welcome");
  const notice = signInNotice(noticeDefault.status);
  const [importSignIns, setImportSignIns] = useState(false);
  // Local HTML and SVG files load without scripts.
  const scriptsOff = isDesktop && !!active && fileKind(active.url) === "markup";
  const ownedByAgent = agentRules(activeSpace) && activeSpace.owner === "agent";
  const barStatus = agentStatus(activeSpace, state, now, seen);
  const ring = barStatus === "browsing" || barStatus === "idle";
  const mac = state.platform === "darwin";
  const bookmarked = state.bookmarks.find(
    (bookmark) => bookmark.url === active?.url,
  );
  // Settings decides for every new agent space, so the dialog says so.
  const forcedIsolation =
    spaceKind === "agent" && state.settings.isolateAgentSpaces;

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4200);
  }, []);
  const attempt = useCallback(async (action: BrowserAction) => {
    try {
      setState(await bridge.dispatch(action));
      return "";
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "Something went wrong. Please try again.";
    }
  }, []);
  const dispatch = useCallback(
    async (action: BrowserAction) => {
      const error = await attempt(action);
      if (error) notify(error);
      return !error;
    },
    [attempt, notify],
  );
  useEffect(() => {
    let alive = true;
    const unsubscribe = bridge.subscribe((next) => {
      if (alive) setState(next);
    });
    bridge
      .getState()
      .then((next) => {
        if (alive) {
          setState(next);
          setReady(true);
        }
      })
      .catch(() => {
        notify("Kamapathy could not load the session. Please restart the app.");
        setReady(true);
      });
    return () => {
      alive = false;
      unsubscribe();
      clearTimeout(toastTimer.current);
    };
  }, [notify]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function syncTheme() {
      document.documentElement.dataset.theme =
        state.settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : state.settings.theme;
    }
    syncTheme();
    media.addEventListener("change", syncTheme);
    return () => media.removeEventListener("change", syncTheme);
  }, [state.settings.theme]);
  useEffect(() => {
    setFormError("");
  }, [overlay]);
  // A reloaded window starts with its pages showing.
  useEffect(() => {
    void bridge.unfreeze();
  }, []);
  // A still frame belongs to the tab it was taken from.
  useLayoutEffect(() => {
    if (!overlayRef.current)
      setFrames((current) => (current.length ? [] : current));
  }, [state.activeTabId, state.splitTabId]);
  useEffect(() => {
    setFindOpen(false);
  }, [active?.id]);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    function sendBounds() {
      const rect = element!.getBoundingClientRect();
      bridge.setContentBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        hidden: !ready,
      });
    }
    sendBounds();
    const observer = new ResizeObserver(sendBounds);
    observer.observe(element);
    window.addEventListener("resize", sendBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sendBounds);
    };
  }, [
    state.settings.showBookmarksBar,
    ready,
    findOpen,
    ownedByAgent,
    googleSignInRejected,
    scriptsOff,
    ring,
    barStatus,
    toast,
  ]);

  const show = useCallback(
    async (next: Overlay) => {
      await freezer.open((captured) => {
        overlayRef.current = next;
        if (captured) setFrames(captured);
        setOverlay(next);
      });
    },
    [freezer],
  );
  const close = useCallback(() => {
    overlayRef.current = null;
    setOverlay(null);
    freezer.close(() => setFrames([]));
  }, [freezer]);
  const [settingsFocus, setSettingsFocus] = useState<"agents">();
  const openSettings = useCallback(
    (focus?: "agents") => {
      setSettingsFocus(focus);
      void show("settings");
    },
    [show],
  );
  // The welcome dialog opens once per profile, on the first launch.
  const welcomed = useRef(false);
  useEffect(() => {
    if (!ready || !isDesktop || state.settings.welcomed || welcomed.current)
      return;
    welcomed.current = true;
    void show("welcome");
  }, [ready, state.settings.welcomed, show]);
  const finishWelcome = useCallback(() => {
    close();
    void dispatch({ type: "settings:update", settings: { welcomed: true } });
  }, [close, dispatch]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  useEffect(() => {
    if (overlay !== "spaces-grid") return;
    let alive = true;
    bridge.thumbnails().then(
      (next) => {
        if (alive) setThumbnails(next);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [overlay]);
  useEffect(() => {
    if (seen !== seenHandoffs) setSeenHandoffs(seen);
  }, [seen, seenHandoffs]);
  useEffect(() => {
    if (
      overlay === "activity" &&
      !state.spaces.some((space) => space.id === activitySpaceId)
    )
      close();
  }, [overlay, activitySpaceId, state.spaces, close]);
  useEffect(() => {
    if (overlay === "space-request" && !state.spaceRequests.length) close();
  }, [overlay, state.spaceRequests, close]);

  const navigate = useCallback(
    (url: string) => {
      if (active) void dispatch({ type: "tab:navigate", id: active.id, url });
      addressRef.current?.blur();
    },
    [active, dispatch],
  );
  const openSpace = useCallback((kind: "personal" | "agent" = "personal") => {
    setSpaceName("");
    setSpaceKind(kind);
    setSpaceColor(kind === "agent" ? "purple" : "green");
    setSpaceSignIns("shared");
    void show("space");
  }, [show]);
  const openBookmark = useCallback(() => {
    setEditingBookmark(null);
    setBookmarkTitle(isHome ? "" : active.title);
    setBookmarkUrl(isHome ? "" : active.url);
    void show("bookmark");
  }, [active, isHome, show]);
  const editBookmark = useCallback(
    (bookmark: Bookmark) => {
      setEditingBookmark(bookmark.id);
      setBookmarkTitle(bookmark.title);
      setBookmarkUrl(bookmark.url);
      void show("bookmark");
    },
    [show],
  );
  const action = useCallback(
    (name: ActionName) => {
      // Anything a shortcut does replaces the open popover or dialog.
      const current = overlayRef.current;
      close();
      switch (name) {
        case "new-tab":
          void dispatch({ type: "tab:create" });
          break;
        case "close-tab":
          if (active) void dispatch({ type: "tab:close", id: active.id });
          break;
        case "reopen-tab":
          void dispatch({ type: "tab:reopen" });
          break;
        case "command":
          void show("command");
          break;
        case "address":
          addressRef.current?.focus();
          addressRef.current?.select();
          break;
        case "find":
          if (!isHome) setFindOpen(true);
          break;
        case "bookmark":
          if (!isHome) openBookmark();
          break;
        case "reload":
          if (active) void dispatch({ type: "tab:reload", id: active.id });
          break;
        case "space":
          openSpace();
          break;
        case "split":
          if (state.splitTabId) void dispatch({ type: "tab:split", id: null });
          else void show("split");
          break;
        case "settings":
          openSettings();
          break;
        case "bookmarks":
        case "history":
        case "downloads":
          void show(name);
          break;
        case "next-tab":
        case "previous-tab": {
          const tabs = spaceTabs(state);
          const index = tabs.findIndex((tab) => tab.id === active?.id);
          const next =
            tabs[
              (index + (name === "next-tab" ? 1 : -1) + tabs.length) %
                tabs.length
            ];
          if (next) void dispatch({ type: "tab:activate", id: next.id });
          break;
        }
        case "screenshot":
          if (!isHome) void dispatch({ type: "page:screenshot" });
          break;
        case "devtools":
          if (!isHome) void dispatch({ type: "page:devtools" });
          break;
        case "zoom-in":
        case "zoom-out":
        case "zoom-reset":
          void dispatch({
            type: "page:zoom",
            direction:
              name === "zoom-in" ? "in" : name === "zoom-out" ? "out" : "reset",
          });
          break;
        case "spaces":
          // close() above already closed the grid if it was open.
          if (current !== "spaces-grid") void show("spaces-grid");
          break;
        default: {
          const unhandled: never = name;
          return unhandled;
        }
      }
    },
    [dispatch, active, isHome, openSpace, openBookmark, state, show, close, openSettings],
  );
  useEffect(
    () =>
      bridge.onShortcut((name) => {
        if (isActionName(name)) action(name);
      }),
    [action],
  );
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const name = keyAction(event, mac);
      if (name) {
        event.preventDefault();
        action(name);
      }
      if (event.key === "Escape") {
        setFindOpen(false);
        addressRef.current?.blur();
        void dispatch({ type: "page:stop-find" });
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [action, dispatch, mac]);
  const menuTab = state.tabs.find((tab) => tab.id === selectedTab);

  return (
    <div className={`browser-app platform-${state.platform}`}>
      <TabStrip
        state={state}
        dispatch={dispatch}
        searchOpen={overlay === "tab-search"}
        onSearch={() => void show("tab-search")}
        onCloseSearch={close}
        onTabMenu={(id) => {
          setSelectedTab(id);
          void show("tab-menu");
        }}
        spaceButton={
          <SpaceButton
            state={state}
            now={now}
            seen={seen}
            open={overlay === "space-popover"}
            buttonRef={spaceTrigger}
            onClick={() =>
              overlay === "space-popover"
                ? close()
                : void show("space-popover")
            }
          />
        }
      />
      <Toolbar
        tab={active}
        isHome={isHome}
        mac={mac}
        agentOwned={ownedByAgent}
        bookmarked={!!bookmarked}
        dispatch={dispatch}
        addressRef={addressRef}
        onNavigate={navigate}
        onToggleBookmark={() => {
          if (bookmarked)
            void dispatch({ type: "bookmark:remove", id: bookmarked.id });
          else if (active)
            void dispatch({
              type: "bookmark:add",
              title: active.title,
              url: active.url,
            });
        }}
        menuRef={menuButton}
        menuOpen={overlay === "menu"}
        onMenu={() => (overlay === "menu" ? close() : void show("menu"))}
      />
      {state.settings.showBookmarksBar && (
        <nav className="bookmarks-bar" aria-label="Bookmarks bar">
          {state.bookmarks.map((bookmark) => (
            <button key={bookmark.id} onClick={() => navigate(bookmark.url)}>
              <SiteIcon url={bookmark.url} size={14} />
              {bookmark.title}
            </button>
          ))}
          <IconButton label="Add bookmark" onClick={openBookmark}>
            <Plus size={14} />
          </IconButton>
        </nav>
      )}
      <main className="page-column">
        {googleSignInRejected && (
          <section
            className="sign-in-notice"
            role="status"
            aria-label="Google sign-in rejected"
          >
            <WarningCircle size={20} />
            <div>
              <strong>{signInNoticeCopy.heading}</strong>
              <p>{notice.message}</p>
            </div>
            {notice.actions.includes("open-external") && (
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  dispatch({ type: "tab:open-external", id: active.id })
                }
              >
                {signInNoticeCopy.open} <ArrowSquareOut size={15} />
              </button>
            )}
            {notice.actions.includes("import-sign-ins") && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setImportSignIns(true);
                  void show("import");
                }}
              >
                {signInNoticeCopy.importSignIns}
              </button>
            )}
            {notice.actions.includes("copy-link") && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void dispatch({ type: "tab:copy-external", id: active.id });
                  notify(signInNoticeCopy.copied);
                }}
              >
                {signInNoticeCopy.copyLink}
              </button>
            )}
          </section>
        )}
        {scriptsOff && (
          <section className="sign-in-notice file-notice" role="status">
            <Info size={20} />
            <div>
              <p>{fileCopy.scriptsOff}</p>
            </div>
          </section>
        )}
        {findOpen && (
          <FindPill
            dispatch={dispatch}
            onClose={() => {
              setFindOpen(false);
              void dispatch({ type: "page:stop-find" });
            }}
          />
        )}
        <div className={`page-frame ${ring ? "agent-ring" : ""}`}>
          <div className="page-viewport" ref={contentRef}>
            {isHome ? (
              <NewTab
                bookmarks={state.bookmarks}
                onNavigate={navigate}
                onAddShortcut={openBookmark}
                onEditShortcut={editBookmark}
                onRemoveShortcut={(id) =>
                  void dispatch({ type: "bookmark:remove", id })
                }
              />
            ) : (
              <div className={`web-page ${splitTab ? "split-preview" : ""}`}>
                {!isDesktop ? (
                  <>
                    <PreviewPage
                      url={active.url}
                      onHome={() => navigate(HOME_URL)}
                    />
                    {splitTab && (
                      <PreviewPage
                        url={splitTab.url}
                        onHome={() => dispatch({ type: "tab:split", id: null })}
                      />
                    )}
                  </>
                ) : active.error ? (
                  <div className="page-error">
                    <WarningCircle size={39} />
                    <h2>This page took a wrong turn.</h2>
                    <p>{active.error}</p>
                    <button
                      className="primary-button"
                      onClick={() =>
                        dispatch({ type: "tab:reload", id: active.id })
                      }
                    >
                      Try again <ArrowClockwise size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="page-loading" aria-live="polite">
                    {active.loading && (
                      <>
                        <div />
                        <p>Finding your way to {hostname(active.url)}...</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {(barStatus || toast) && (
          <div className="page-footer">
            {barStatus && (
              <AgentBar
                key={activeSpace.id}
                space={activeSpace}
                status={barStatus}
                attempt={attempt}
              />
            )}
            {toast && (
              <div className="toast" role="status">
                <Info size={15} />
                <span>{toast}</span>
                <IconButton
                  label="Dismiss notification"
                  onClick={() => setToast("")}
                >
                  <X size={14} />
                </IconButton>
              </div>
            )}
          </div>
        )}
      </main>
      {frames.map((frame) => (
        <img
          key={`${frame.x},${frame.y}`}
          className="frozen-frame"
          src={frame.image}
          alt=""
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
          }}
        />
      ))}
      <CommandPalette
        open={overlay === "command"}
        onClose={close}
        state={state}
        onNavigate={navigate}
        onTab={(id) => dispatch({ type: "tab:activate", id })}
        onAction={action}
      />
      <Settings
        open={overlay === "settings"}
        onClose={close}
        state={state}
        dispatch={dispatch}
        focus={settingsFocus}
        onImport={() => {
          setImportSignIns(false);
          void show("import");
        }}
      />
      <Welcome
        open={overlay === "welcome"}
        state={state}
        onOpenSite={(url) =>
          void dispatch({ type: "tab:create", url, background: true })
        }
        onClose={finishWelcome}
        defaultBrowser={welcomeDefault.status}
        onMakeDefault={() => void welcomeDefault.makeDefault()}
      />
      <Modal
        open={overlay === "import"}
        onClose={close}
        title={importCopy.title}
        description={importCopy.description}
      >
        {overlay === "import" && (
          <ImportPanel onDone={close} signIns={importSignIns} />
        )}
      </Modal>
      <LibraryDialog
        kind={
          overlay === "bookmarks" ||
          overlay === "history" ||
          overlay === "downloads"
            ? overlay
            : null
        }
        onClose={close}
        state={state}
        dispatch={dispatch}
        onNavigate={(url) => {
          close();
          navigate(url);
        }}
        onAddBookmark={openBookmark}
      />
      <Modal
        open={overlay === "space"}
        onClose={close}
        title={
          spaceKind === "agent"
            ? "A space for your agent"
            : "Make a little space"
        }
        description={
          spaceKind === "agent"
            ? "A space an agent works in. You decide when it can access it."
            : "Group your tabs for each part of your day."
        }
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!spaceName.trim()) {
              setFormError("Give your space a name.");
              return;
            }
            if (
              await dispatch({
                type: "space:create",
                name: spaceName,
                color: spaceColor,
                kind: spaceKind,
                signIns: spaceSignIns,
              })
            ) {
              close();
            }
          }}
        >
          <label className="field-label" htmlFor="space-name">
            Space name
          </label>
          <input
            id="space-name"
            className="text-input"
            autoFocus
            maxLength={40}
            placeholder={
              spaceKind === "agent"
                ? "e.g. Research assistant"
                : "e.g. Weekend project"
            }
            value={spaceName}
            onChange={(event) => setSpaceName(event.target.value)}
          />
          <p className="field-label">{spacesCopy.kind}</p>
          <div className="kind-options" role="group" aria-label={spacesCopy.kind}>
            {(["personal", "agent"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={spaceKind === kind}
                onClick={() => setSpaceKind(kind)}
              >
                {kind === "agent" ? spacesCopy.agent : spacesCopy.personal}
              </button>
            ))}
          </div>
          <label className="field-label">A color of its own</label>
          <div className="color-options">
            {(["green", "blue", "orange", "purple"] as const).map((color) => (
              <button
                type="button"
                key={color}
                aria-label={`${color} space color`}
                aria-pressed={spaceColor === color}
                className={`color-option color-${color} ${spaceColor === color ? "selected" : ""}`}
                onClick={() => setSpaceColor(color)}
              >
                {spaceColor === color && <Check size={17} />}
              </button>
            ))}
          </div>
          <div className="form-switch">
            <div>
              <strong>{signInsCopy.label}</strong>
              <p>
                {forcedIsolation
                  ? signInsCopy.forced
                  : spaceKind === "agent"
                    ? signInsCopy.agent
                    : signInsCopy.personal}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={signInsCopy.label}
              aria-checked={forcedIsolation || spaceSignIns === "separate"}
              disabled={forcedIsolation}
              className={`toggle ${forcedIsolation || spaceSignIns === "separate" ? "on" : ""}`}
              onClick={() =>
                setSpaceSignIns(
                  spaceSignIns === "separate" ? "shared" : "separate",
                )
              }
            >
              <span />
            </button>
          </div>
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={close}
            >
              Cancel
            </button>
            <button className="primary-button" type="submit">
              Create space <ArrowRight size={16} />
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={overlay === "bookmark"}
        onClose={close}
        title={editingBookmark ? newTabCopy.editTitle : "Keep something good"}
        description={
          editingBookmark
            ? newTabCopy.editDescription
            : "Add a favorite to your new tab page and bookmarks."
        }
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!bookmarkUrl.trim()) {
              setFormError("Enter a website address.");
              return;
            }
            const error = await attempt(
              editingBookmark
                ? {
                    type: "bookmark:update",
                    id: editingBookmark,
                    title: bookmarkTitle,
                    url: bookmarkUrl,
                  }
                : { type: "bookmark:add", title: bookmarkTitle, url: bookmarkUrl },
            );
            if (error) {
              setFormError(error);
              return;
            }
            close();
            notify(editingBookmark ? newTabCopy.saved : "Bookmark saved.");
          }}
        >
          <label className="field-label" htmlFor="bookmark-name">
            Name
          </label>
          <input
            id="bookmark-name"
            autoFocus
            className="text-input"
            placeholder="A name to remember"
            value={bookmarkTitle}
            onChange={(event) => setBookmarkTitle(event.target.value)}
          />
          <label className="field-label" htmlFor="bookmark-url">
            Website address
          </label>
          <input
            id="bookmark-url"
            className="text-input"
            placeholder="https://example.com"
            value={bookmarkUrl}
            onChange={(event) => setBookmarkUrl(event.target.value)}
          />
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={close}
            >
              Cancel
            </button>
            <button className="primary-button" type="submit">
              {editingBookmark ? newTabCopy.save : "Save bookmark"} <BookmarkSimple size={16} />
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={overlay === "split"}
        onClose={close}
        title="A wider perspective"
        description="Choose another page in this space to view alongside the current tab."
      >
        <div className="split-options">
          {state.tabs
            .filter(
              (tab) =>
                tab.spaceId === state.activeSpaceId &&
                tab.id !== active?.id &&
                tab.url !== HOME_URL,
            )
            .map((tab) => (
              <button
                key={tab.id}
                onClick={() => {
                  void dispatch({ type: "tab:split", id: tab.id });
                  close();
                }}
              >
                <SiteIcon url={tab.url} />
                <span>
                  <strong>{tab.title}</strong>
                  <small>{hostname(tab.url)}</small>
                </span>
                <Columns size={18} />
              </button>
            ))}
        </div>
        {isHome ? (
          <p className="info-note">
            Open a website in this tab first, then choose a second page for
            split view.
          </p>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const input = new FormData(event.currentTarget).get(
                "split-url",
              ) as string;
              if (!input.trim()) return;
              try {
                const previousIds = new Set(state.tabs.map((tab) => tab.id));
                const next = await bridge.dispatch({
                  type: "tab:create",
                  url: input,
                  background: true,
                });
                const created = next.tabs.find(
                  (tab) => !previousIds.has(tab.id),
                );
                if (created)
                  await dispatch({ type: "tab:split", id: created.id });
                close();
              } catch (error) {
                notify(
                  error instanceof Error
                    ? error.message
                    : "Could not open split view.",
                );
              }
            }}
          >
            <label className="field-label" htmlFor="split-url">
              Or open a new page alongside
            </label>
            <div className="inline-form">
              <input
                id="split-url"
                className="text-input"
                name="split-url"
                placeholder="Enter a URL or search"
              />
              <button className="primary-button" type="submit">
                <Plus size={18} /> Open
              </button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={overlay === "tab-menu"}
        onClose={close}
        title={menuTab?.title || "Tab options"}
        className="small-modal"
      >
        <div className="action-menu">
          {menuTab && (
            <>
              <button
                onClick={() => {
                  void dispatch({ type: "tab:pin", id: menuTab.id });
                  close();
                }}
              >
                <PushPin size={18} />
                {menuTab.pinned ? "Unpin tab" : "Pin tab"}
              </button>
              <button
                onClick={() => {
                  void dispatch({ type: "tab:duplicate", id: menuTab.id });
                  close();
                }}
              >
                <Copy size={18} />
                Duplicate tab
              </button>
              <button
                onClick={() => {
                  void dispatch({ type: "tab:close", id: menuTab.id });
                  close();
                }}
              >
                <X size={18} />
                Close tab
              </button>
            </>
          )}
        </div>
      </Modal>
      <ToolsMenu
        open={overlay === "menu"}
        onClose={close}
        anchor={menuButton}
        mac={mac}
        isHome={isHome}
        onAction={action}
      />
      <SpacePopover
        open={overlay === "space-popover"}
        anchor={spaceTrigger}
        state={state}
        now={now}
        seen={seen}
        dispatch={dispatch}
        onClose={close}
        onAction={action}
        onAgentSettings={() => openSettings("agents")}
        mac={mac}
        onViewActivity={(id) => {
          setActivitySpaceId(id);
          void show("activity");
        }}
        onRequest={() => void show("space-request")}
      />
      <SpaceRequestDialog
        open={overlay === "space-request"}
        state={state}
        onClose={close}
        attempt={attempt}
      />
      <ActivityDialog
        space={
          overlay === "activity"
            ? state.spaces.find((space) => space.id === activitySpaceId)
            : undefined
        }
        state={state}
        onClose={close}
      />
      <SpacesOverview
        open={overlay === "spaces-grid"}
        onClose={close}
        state={state}
        now={now}
        seen={seen}
        thumbnails={thumbnails}
        dispatch={dispatch}
      />
    </div>
  );
}
function PreviewPage({ url, onHome }: { url: string; onHome: () => void }) {
  return (
    <div className="preview-page">
      <div className="preview-browser-symbol">
        <GlobeHemisphereWest size={34} />
        <span>
          <ArrowUpRight size={16} />
        </span>
      </div>
      <span className="eyebrow">You are exploring the web preview</span>
      <h2>
        The whole web.
        <br />
        In the desktop app.
      </h2>
      <p>
        Kamapathy opens real websites in its own browser engine on macOS, Windows,
        and Linux.
      </p>
      <div className="preview-url">
        <LockSimple size={15} />
        <span>{url}</span>
      </div>
      <a className="primary-button" href={url} target="_blank" rel="noreferrer">
        Open in your browser <ArrowSquareOut size={16} />
      </a>
      <button className="text-button" onClick={onHome}>
        Back to your space <ArrowLeft size={15} />
      </button>
      <p className="preview-note">
        Tabs, spaces, bookmarks, and settings work in this preview. Desktop
        browsing uses Electron and Chromium.
      </p>
    </div>
  );
}
