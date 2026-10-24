import { useEffect, useRef, useState } from "react";
import {
  Monitor,
  Moon,
  Sun,
  TreeEvergreen,
} from "@phosphor-icons/react";
import type {
  AgentSetupStatus,
  BrowserAction,
  BrowserState,
  DefaultBrowserStatus,
  Theme,
} from "../../shared/types";
import { Modal } from "./ui";
import { UpdatesSection } from "./Updates";
import { bridge, isDesktop } from "../lib/bridge";
import {
  agentSetupCopy,
  defaultBrowserCopy,
  extensionsCopy,
  settingsCopy,
} from "../copy";
import { activityTime } from "../lib/spaces";
import { setupSummary } from "../lib/setupView";
import { useDefaultBrowser } from "../lib/useDefaultBrowser";
import "./Spaces.css";

function defaultBrowserNote(
  status: DefaultBrowserStatus,
  platform: BrowserState["platform"],
): string {
  if (status.state !== "unavailable")
    return status.state === "default"
      ? defaultBrowserCopy.isDefault
      : defaultBrowserCopy.available;
  return {
    development: defaultBrowserCopy.development,
    "disk-image": defaultBrowserCopy.diskImage,
    portable: defaultBrowserCopy.portable,
    "not-installed":
      platform === "win32"
        ? defaultBrowserCopy.windowsNotInstalled
        : defaultBrowserCopy.linuxNotInstalled,
    web: "",
  }[status.reason];
}

export function Settings({
  open,
  onClose,
  state,
  dispatch,
  focus,
  onImport,
  onPasswords,
  onAgentSetup,
  onInstall,
  onWhatsNew,
  onExtensions,
}: {
  open: boolean;
  onClose: () => void;
  state: BrowserState;
  dispatch: (action: BrowserAction) => void;
  focus?: "agents" | "updates";
  onImport: () => void;
  onPasswords: () => void;
  onAgentSetup: () => void;
  onInstall: () => void;
  onWhatsNew: () => void;
  onExtensions: () => void;
}) {
  const agentSwitch = useRef<HTMLButtonElement>(null);
  const updateSwitch = useRef<HTMLButtonElement>(null);
  // Read again at each opening, without the slower shell probe.
  const [setup, setSetup] = useState<AgentSetupStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    bridge.agentSetupStatus().then(
      (next) => {
        if (alive) setSetup(next);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [open]);
  const defaultBrowser = useDefaultBrowser(open);
  const warning =
    state.settings.automationEnabled && !state.automation.running
      ? state.activity.find((item) => !item.spaceId && item.kind === "warning")
      : undefined;
  const update = (
    settings: Parameters<typeof dispatch>[0] & { type: "settings:update" },
  ) => dispatch(settings);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Make Kamapathy yours"
      className="settings-modal"
      initialFocus={
        focus === "agents"
          ? agentSwitch
          : focus === "updates"
            ? updateSwitch
            : undefined
      }
    >
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="theme-options">
          {(
            [
              { value: "light", title: "Light", icon: <Sun size={18} /> },
              { value: "dark", title: "Dark", icon: <Moon size={18} /> },
              { value: "system", title: "System", icon: <Monitor size={18} /> },
            ] as const
          ).map((theme) => (
            <button
              key={theme.value}
              className={`theme-option ${theme.value} ${state.settings.theme === theme.value ? "selected" : ""}`}
              onClick={() =>
                update({
                  type: "settings:update",
                  settings: { theme: theme.value as Theme },
                })
              }
              aria-pressed={state.settings.theme === theme.value}
            >
              <span className="theme-preview">
                <i />
                <span>
                  <b />
                  <b />
                  <b />
                </span>
              </span>
              <span>
                {theme.icon}
                {theme.title}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <h3>Browsing</h3>
        <div className="setting-row">
          <div>
            <strong>Search engine</strong>
          </div>
          <select
            aria-label="Default search engine"
            value={state.settings.searchEngine}
            onChange={(event) =>
              update({
                type: "settings:update",
                settings: {
                  searchEngine: event.target
                    .value as BrowserState["settings"]["searchEngine"],
                },
              })
            }
          >
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
          </select>
        </div>
        {state.platform !== "web" && (
          <div className="setting-row">
            <div>
              <strong>{defaultBrowserCopy.label}</strong>
              {defaultBrowser.status && (
                <p>
                  {defaultBrowserNote(defaultBrowser.status, state.platform)}
                </p>
              )}
            </div>
            {defaultBrowser.status?.state === "available" && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => void defaultBrowser.makeDefault()}
              >
                {defaultBrowserCopy.make}
              </button>
            )}
          </div>
        )}
        <div className="setting-row">
          <div>
            <strong>Restore tabs on startup</strong>
            <p>Restore personal tabs when Kamapathy opens.</p>
          </div>
          <button
            role="switch"
            aria-label="Restore previous session"
            aria-checked={state.settings.restoreSession}
            className={`toggle ${state.settings.restoreSession ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: { restoreSession: !state.settings.restoreSession },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Bookmarks bar</strong>
            <p>Show saved pages below the address bar.</p>
          </div>
          <button
            role="switch"
            aria-label="Show bookmarks bar"
            aria-checked={state.settings.showBookmarksBar}
            className={`toggle ${state.settings.showBookmarksBar ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: {
                  showBookmarksBar: !state.settings.showBookmarksBar,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{settingsCopy.import}</strong>
            <p>{settingsCopy.importNote}</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={!isDesktop}
            onClick={onImport}
          >
            {settingsCopy.importButton}
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h3>{settingsCopy.passwords}</h3>
        <div className="setting-row">
          <div>
            <strong>{settingsCopy.offerToSave}</strong>
            <p>{settingsCopy.offerToSaveNote}</p>
          </div>
          <button
            role="switch"
            aria-label={settingsCopy.offerToSave}
            aria-checked={state.settings.offerToSavePasswords}
            className={`toggle ${state.settings.offerToSavePasswords ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: {
                  offerToSavePasswords: !state.settings.offerToSavePasswords,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{settingsCopy.savedPasswords}</strong>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={onPasswords}
          >
            {settingsCopy.manage}
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h3>{extensionsCopy.settingsTitle}</h3>
        <div className="setting-row">
          <div>
            <strong>{extensionsCopy.updates}</strong>
            <p>{extensionsCopy.updatesHint}</p>
          </div>
          <button
            role="switch"
            aria-label={extensionsCopy.updates}
            aria-checked={state.settings.extensionUpdates}
            className={`toggle ${state.settings.extensionUpdates ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: {
                  extensionUpdates: !state.settings.extensionUpdates,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{extensionsCopy.developer}</strong>
            <p>{extensionsCopy.developerHint}</p>
          </div>
          <button
            role="switch"
            aria-label={extensionsCopy.developer}
            aria-checked={state.settings.extensionDeveloperMode}
            className={`toggle ${state.settings.extensionDeveloperMode ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: {
                  extensionDeveloperMode:
                    !state.settings.extensionDeveloperMode,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <button
          type="button"
          className="secondary-button extensions-manage"
          disabled={!isDesktop}
          onClick={onExtensions}
        >
          {extensionsCopy.manage}
        </button>
      </section>
      <section className="settings-section" aria-labelledby="settings-agents">
        <h3 id="settings-agents">{settingsCopy.agents}</h3>
        <div className="setting-row">
          <div>
            <strong>{settingsCopy.access}</strong>
            <p>
              {isDesktop
                ? "Agents on this computer connect automatically while this is on. They never see your personal tabs."
                : "Install the desktop app to connect an agent."}
            </p>
          </div>
          <button
            ref={agentSwitch}
            role="switch"
            aria-label="Enable agent connection"
            aria-checked={state.settings.automationEnabled}
            className={`toggle ${state.settings.automationEnabled ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: {
                  automationEnabled: !state.settings.automationEnabled,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{settingsCopy.isolate}</strong>
            <p>{settingsCopy.isolateNote}</p>
          </div>
          <button
            role="switch"
            aria-label={settingsCopy.isolate}
            aria-checked={state.settings.isolateAgentSpaces}
            className={`toggle ${state.settings.isolateAgentSpaces ? "on" : ""}`}
            onClick={() =>
              update({
                type: "settings:update",
                settings: {
                  isolateAgentSpaces: !state.settings.isolateAgentSpaces,
                },
              })
            }
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{agentSetupCopy.settingsRow}</strong>
            <p>{setupSummary(setup)}</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={!isDesktop}
            onClick={onAgentSetup}
          >
            {agentSetupCopy.settingsButton}
          </button>
        </div>
        <p className="agent-connection">
          <span
            className={`connection-status ${state.automation.running ? "online" : ""}`}
          />
          {state.automation.running ? "Connection is on" : "Connection is off"}
        </p>
        {warning && (
          <p className="form-error" role="alert">
            {warning.message}
          </p>
        )}
        <p className="setting-note">{settingsCopy.spaces}</p>
        <h4 id="settings-activity" className="settings-subheading">
          {settingsCopy.activity}
        </h4>
        {state.activity.length ? (
          <ol className="activity-entries" aria-labelledby="settings-activity">
            {state.activity.slice(0, 25).map((item) => (
              <li key={item.id}>
                <span>{item.message}</span>
                <time>{activityTime(item.time)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="setting-note">{settingsCopy.noActivity}</p>
        )}
      </section>
      {isDesktop && (
        <UpdatesSection
          state={state}
          dispatch={dispatch}
          onInstall={onInstall}
          onWhatsNew={onWhatsNew}
          switchRef={updateSwitch}
        />
      )}
      <div className="settings-about">
        <span className="brand-mark">
          <TreeEvergreen size={23} weight="fill" />
        </span>
        <div>
          <strong>
            Kamapathy <span>{state.version}</span>
          </strong>
        </div>
        <span className="platform-label">
          {state.platform === "web"
            ? "Web preview"
            : state.platform === "darwin"
              ? "macOS"
              : state.platform === "win32"
                ? "Windows"
                : "Linux"}
        </span>
      </div>
    </Modal>
  );
}
