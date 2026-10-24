import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromptBar, promptAnswer } from "../src/components/PromptBar";
import type { PendingPrompt, Space } from "../shared/types";

const personal: Space = {
  id: "personal",
  name: "Personal",
  color: "green",
  kind: "personal",
  owner: "human",
  signIns: "shared",
  createdAt: 1,
};
const agentSpace: Space = {
  ...personal,
  id: "task",
  name: "Order lunch",
  kind: "agent",
  owner: "agent",
};

function pending(fields: Partial<PendingPrompt>): PendingPrompt {
  return {
    id: "p1",
    spaceId: personal.id,
    tabId: "t1",
    kind: "location",
    at: 5,
    agent: false,
    ...fields,
  };
}
function bar(prompt: PendingPrompt, space = personal, total?: number): string {
  return renderToStaticMarkup(
    <PromptBar
      prompt={prompt}
      space={space}
      total={total}
      onAnswer={async () => ""}
    />,
  );
}
// The words the person reads, without the markup around them.
function plain(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("the prompt bar", () => {
  it("shows the origin, Block and Allow, and answers through answerPrompt", () => {
    const prompt = pending({ origin: "https://maps.example" });
    const markup = bar(prompt);
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Personal"');
    expect(plain(markup)).toContain(
      "https://maps.example wants to know your location",
    );
    expect(markup).toContain(">Allow<");
    expect(markup).not.toContain("disabled");
    expect(markup.indexOf(">Block<")).toBeGreaterThan(
      markup.indexOf(">Allow<"),
    );
    expect(promptAnswer(prompt, { allow: true })).toEqual({
      id: "p1",
      allow: true,
    });
    expect(promptAnswer(prompt, { allow: false })).toEqual({
      id: "p1",
      allow: false,
    });
    // A permission with no line of its own still names what it asks for.
    const other = plain(
      bar(pending({ kind: "midi-sysex", origin: "https://studio.example" })),
    );
    expect(other).toContain(
      "https://studio.example wants a browser permission",
    );
    expect(other).toContain("MIDI devices and their system messages");
  });

  it("lists devices with Connect, takes typed credentials, warns on a retry and offers Don't send", () => {
    const device = pending({
      kind: "usb",
      origin: "https://arduino.example",
      devices: [
        { id: "d1", name: "Bus pirate" },
        { id: "d2", name: "Thermometer" },
      ],
    });
    const devices = bar(device);
    expect(plain(devices)).toContain(
      "https://arduino.example wants to connect to a USB device",
    );
    expect(plain(devices)).toContain("Bus pirate");
    expect(plain(devices)).toContain("Thermometer");
    expect(devices).toContain(">Connect<");
    expect(promptAnswer(device, { allow: true, deviceId: "d2" })).toEqual({
      id: "p1",
      allow: true,
      deviceId: "d2",
    });
    // Nothing chosen is a Block, never an open grant.
    expect(promptAnswer(device, { allow: true })).toEqual({
      id: "p1",
      allow: false,
    });
    const none = bar(
      pending({ kind: "hid", origin: "https://arduino.example", devices: [] }),
    );
    expect(plain(none)).toContain("No devices found.");
    expect(none).not.toContain(">Connect<");
    expect(none).toContain(">Block<");

    const signIn = pending({
      kind: "http_sign_in",
      signIn: {
        host: "files.example",
        realm: "Staff only",
        proxy: false,
        retry: true,
      },
    });
    const form = bar(signIn);
    expect(plain(form)).toContain("Sign in to files.example");
    expect(plain(form)).toContain('The site says "Staff only"');
    expect(plain(form)).toContain("That didn't work. Try again.");
    expect(form).toContain('type="password"');
    // Nothing to send until the person types a name.
    expect(form).toContain("disabled");
    expect(form.toLowerCase()).toContain('autocomplete="off"');
    // Both fields start empty, so nothing the person typed is ever re-rendered.
    expect(form.match(/value=""/g)).toHaveLength(2);
    expect(
      promptAnswer(signIn, {
        allow: true,
        username: "ada",
        password: "hunter2",
      }),
    ).toEqual({
      id: "p1",
      allow: true,
      credentials: { username: "ada", password: "hunter2" },
    });
    expect(
      promptAnswer(signIn, {
        allow: false,
        username: "ada",
        password: "hunter2",
      }),
    ).toEqual({ id: "p1", allow: false });
    const first = plain(
      bar(
        pending({
          kind: "http_sign_in",
          signIn: { host: "files.example", proxy: false, retry: false },
        }),
      ),
    );
    expect(first).not.toContain("Try again");
    expect(first).not.toContain("The site says");

    const certificate = pending({
      kind: "client_certificate",
      origin: "https://bank.example",
      certificates: [
        {
          id: "c1",
          subject: "Ada Lovelace",
          issuer: "Example CA",
          expires: 2000000000,
        },
      ],
    });
    const list = bar(certificate);
    expect(plain(list)).toContain("bank.example asks for a certificate");
    expect(plain(list)).toContain("Ada Lovelace");
    expect(plain(list)).toContain("Example CA");
    expect(plain(list)).toContain("Don't send");
    expect(
      promptAnswer(certificate, { allow: true, certificateId: "c1" }),
    ).toEqual({ id: "p1", allow: true, certificateId: "c1" });
    expect(promptAnswer(certificate, { allow: true })).toEqual({
      id: "p1",
      allow: false,
    });
  });

  it("shows the waiting line in an agent space and the remembered line in a personal one", () => {
    const waiting = plain(
      bar(
        pending({
          spaceId: agentSpace.id,
          origin: "https://maps.example",
          agent: true,
        }),
        agentSpace,
        3,
      ),
    );
    expect(waiting).toContain("The agent is waiting for you.");
    expect(waiting).not.toContain("Kamapathy remembers");
    expect(waiting).toContain("1 of 3");
    const remembered = plain(bar(pending({ origin: "https://maps.example" })));
    expect(remembered).toContain("Kamapathy remembers this for Personal.");
    expect(remembered).not.toContain("The agent is waiting");
    expect(remembered).not.toContain("1 of");
    // Device, sign-in and certificate answers are never saved.
    for (const prompt of [
      pending({ kind: "usb", origin: "https://arduino.example", devices: [] }),
      pending({
        kind: "http_sign_in",
        signIn: { host: "files.example", proxy: false, retry: false },
      }),
    ])
      expect(plain(bar(prompt))).not.toContain("Kamapathy remembers");
  });
});
