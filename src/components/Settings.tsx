import { useRef } from "react";
import {
  Monitor,
  Moon,
  Sun,
  TreeEvergreen,
} from "@phosphor-icons/react";
import type { BrowserAction, BrowserState, Theme } from "../../shared/types";
import { Modal } from "./ui";
import { isDesktop } from "../lib/bridge";
import { settingsCopy } from "../copy";
import { activityTime } from "../lib/spaces";
import "./Spaces.css";

export function Settings({
  open,
  onClose,
  state,
  dispatch,
  focus,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  state: BrowserState;
  dispatch: (action: BrowserAction) => void;
  focus?: "agents";
  onImport: () => void;
}) {
  const agentSwitch = useRef<HTMLButtonElement>(null);
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
      initialFocus={focus === "agents" ? agentSwitch : undefined}
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
        <p className="setting-note">{settingsCopy.background}</p>
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
