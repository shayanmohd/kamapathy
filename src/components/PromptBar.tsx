import { Fragment, useState } from "react";
import { permissionWords, type PromptKind } from "../../shared/permissions";
import type { PendingPrompt, PromptAnswer, Space } from "../../shared/types";
import { hostname } from "../../shared/url";
import { passwordsCopy, promptBarCopy } from "../copy";
import "./PromptBar.css";

// What the person picked in the bar, before it becomes an answer.
export interface PromptChoice {
  allow: boolean;
  deviceId?: string;
  certificateId?: string;
  username?: string;
  password?: string;
  savedLoginId?: string;
  save?: boolean;
}

// The kinds with a line of their own. Everything else asks under the plain
// line and names the permission in words.
const LINES: Partial<Record<PromptKind, string>> = {
  location: promptBarCopy.location,
  notifications: promptBarCopy.notifications,
  camera: promptBarCopy.camera,
  microphone: promptBarCopy.microphone,
  camera_microphone: promptBarCopy.camera_microphone,
  midi: promptBarCopy.midi,
  usb: promptBarCopy.usb,
  hid: promptBarCopy.hid,
  serial: promptBarCopy.serial,
  bluetooth: promptBarCopy.bluetooth,
};

/** The answer a choice makes. Nothing picked is a Block, never a grant. */
export function promptAnswer(
  prompt: PendingPrompt,
  choice: PromptChoice,
): PromptAnswer {
  const block: PromptAnswer = { id: prompt.id, allow: false };
  if (!choice.allow) return block;
  if (prompt.devices)
    return choice.deviceId
      ? { id: prompt.id, allow: true, deviceId: choice.deviceId }
      : block;
  // A saved sign-in travels as its id: main opens it and answers the page.
  if (prompt.signIn && choice.savedLoginId)
    return { id: prompt.id, allow: true, savedLoginId: choice.savedLoginId };
  if (prompt.signIn)
    return choice.username
      ? {
          id: prompt.id,
          allow: true,
          credentials: {
            username: choice.username,
            password: choice.password ?? "",
          },
          ...(prompt.canSave && choice.save ? { save: true } : {}),
        }
      : block;
  if (prompt.certificates)
    return choice.certificateId
      ? { id: prompt.id, allow: true, certificateId: choice.certificateId }
      : block;
  return { id: prompt.id, allow: true };
}

// The copy keeps its whole sentence, so the button splits on this mark to
// show the username bidi-isolated.
const VALUE = "\u0000";
function signInAs(username: string) {
  const parts = passwordsCopy.signIn.as(VALUE).split(VALUE);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && <bdi>{username}</bdi>}
    </Fragment>
  ));
}

function heading(prompt: PendingPrompt): string {
  if (prompt.signIn)
    return promptBarCopy.signIn.replace("{host}", prompt.signIn.host);
  if (prompt.certificates)
    return promptBarCopy.certificate.replace(
      "{host}",
      prompt.host || hostname(prompt.origin ?? ""),
    );
  return (LINES[prompt.kind] ?? promptBarCopy.other).replace(
    "{origin}",
    prompt.origin ?? prompt.host ?? "",
  );
}

// Electron gives a certificate's expiry in seconds.
function expiry(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "";
}

export function PromptBar({
  prompt,
  space,
  total,
  onAnswer,
}: {
  prompt: PendingPrompt;
  space: Space;
  total?: number;
  onAnswer: (answer: PromptAnswer) => Promise<string>;
}) {
  // What the person types stays here: never in an action, never in state on
  // disk, and gone with the bar.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [certificateId, setCertificateId] = useState("");
  // The box is ticked until the person unticks it.
  const [save, setSave] = useState(true);
  const [error, setError] = useState("");
  const { devices, certificates, signIn } = prompt;
  const permission = !devices && !certificates && !signIn;
  // A device or certificate that left the list is gone, so the first one of
  // what is there now is picked.
  const device =
    devices?.find((item) => item.id === deviceId)?.id ?? devices?.[0]?.id ?? "";
  const certificate =
    certificates?.find((item) => item.id === certificateId)?.id ??
    certificates?.[0]?.id ??
    "";
  const words =
    permission && !LINES[prompt.kind] ? permissionWords(prompt.kind) : "";
  async function answer(choice: PromptChoice) {
    setError(await onAnswer(promptAnswer(prompt, choice)));
  }
  return (
    <section className="prompt-bar" role="region" aria-label={space.name}>
      <div className="prompt-bar-text" role="status">
        <strong>{heading(prompt)}</strong>
        {words && <p>{words}</p>}
        {signIn?.realm && (
          <p className="prompt-bar-realm">
            {promptBarCopy.realm.replace("{realm}", signIn.realm)}
          </p>
        )}
        {signIn?.retry && (
          <p className="prompt-bar-retry">{promptBarCopy.retry}</p>
        )}
        {prompt.agent && <p>{promptBarCopy.agentWaiting}</p>}
        {permission && space.kind === "personal" && (
          <p>{promptBarCopy.remembered.replace("{space}", space.name)}</p>
        )}
        {!!total && total > 1 && <p>{promptBarCopy.count(total)}</p>}
      </div>
      {devices &&
        (devices.length ? (
          <div
            className="prompt-bar-choices"
            role="radiogroup"
            aria-label={promptBarCopy.devices}
          >
            {devices.map((item) => (
              <label key={item.id} className="prompt-bar-choice">
                <input
                  type="radio"
                  name="prompt-device"
                  checked={device === item.id}
                  onChange={() => setDeviceId(item.id)}
                />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="prompt-bar-none">{promptBarCopy.noDevices}</p>
        ))}
      {certificates && (
        <div
          className="prompt-bar-choices"
          role="radiogroup"
          aria-label={promptBarCopy.certificates}
        >
          {certificates.map((item) => (
            <label key={item.id} className="prompt-bar-choice">
              <input
                type="radio"
                name="prompt-certificate"
                checked={certificate === item.id}
                onChange={() => setCertificateId(item.id)}
              />
              <span>
                {item.subject}
                <small>
                  {item.issuer} · {expiry(item.expires)}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
      {!!prompt.savedLogins?.length && (
        <div className="prompt-bar-logins">
          {prompt.savedLogins.map((login) => (
            <button
              key={login.id}
              type="button"
              className="secondary-button"
              onClick={() =>
                void answer({ allow: true, savedLoginId: login.id })
              }
            >
              {signInAs(login.username)}
            </button>
          ))}
        </div>
      )}
      {signIn && (
        <div className="prompt-bar-fields">
          <div className="prompt-bar-field">
            <label className="field-label" htmlFor="prompt-username">
              {promptBarCopy.username}
            </label>
            <input
              id="prompt-username"
              className="text-input"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="prompt-bar-field">
            <label className="field-label" htmlFor="prompt-password">
              {promptBarCopy.password}
            </label>
            <input
              id="prompt-password"
              type="password"
              className="text-input"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {prompt.canSave && (
              <label className="prompt-bar-save">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(event) => setSave(event.target.checked)}
                />
                <span>{passwordsCopy.signIn.save}</span>
              </label>
            )}
          </div>
        </div>
      )}
      <div className="prompt-bar-actions">
        {(!devices || devices.length > 0) && (
          <button
            type="button"
            className="primary-button"
            disabled={!!signIn && !username}
            onClick={() =>
              void answer({
                allow: true,
                deviceId: device,
                certificateId: certificate,
                username,
                password,
                save,
              })
            }
          >
            {devices ? promptBarCopy.connect : promptBarCopy.allow}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={() => void answer({ allow: false })}
        >
          {certificates ? promptBarCopy.dontSend : promptBarCopy.block}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
