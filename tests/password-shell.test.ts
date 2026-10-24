import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  BrowserState,
  PasswordPrompt,
  PendingPrompt,
  SavedLoginSummary,
} from "../shared/types";
import { initialState } from "../shared/state";
import {
  compromisedCount,
  filterLogins,
  importSummaryLines,
  isPasswordError,
  loginHost,
  shownPasswordPrompt,
  sortLogins,
} from "../src/lib/passwords";
import { PasswordPromptBar } from "../src/components/PasswordPrompt";

function login(
  origin: string,
  username: string,
  extra: Partial<SavedLoginSummary> = {},
): SavedLoginSummary {
  return {
    id: `${origin} ${username}`,
    kind: "form",
    origin,
    username,
    createdAt: 1,
    changedAt: 1,
    ...extra,
  };
}
const names = (logins: SavedLoginSummary[]) => logins.map((item) => item.id);

describe("saved password rows", () => {
  it("sorts by host without www, then username", () => {
    const sorted = sortLogins([
      login("https://b.example", "bob"),
      login("https://www.b.example", "alice"),
      login("https://a.example", "zed"),
      login("http://b.example", "Carol", { kind: "http", realm: "Admin" }),
    ]);
    expect(names(sorted)).toEqual([
      "https://a.example zed",
      "https://www.b.example alice",
      "https://b.example bob",
      "http://b.example Carol",
    ]);
    expect(loginHost("https://www.b.example")).toBe("b.example");
  });
  it("searches host and username and counts compromised logins", () => {
    const logins = [
      login("https://www.shop.example", "ana"),
      login("https://mail.example", "ana.shop"),
      login("https://bank.example", "finance", { compromised: "leaked" }),
      login("https://news.example", "reader", { compromised: "phished" }),
    ];
    expect(names(filterLogins(logins, "SHOP", false))).toEqual([
      "https://www.shop.example ana",
      "https://mail.example ana.shop",
    ]);
    expect(names(filterLogins(logins, "bank", false))).toEqual([
      "https://bank.example finance",
    ]);
    expect(filterLogins(logins, "https", false)).toEqual([]);
    expect(filterLogins(logins, "www", false)).toEqual([]);
    expect(names(filterLogins(logins, "", true))).toEqual([
      "https://bank.example finance",
      "https://news.example reader",
    ]);
    expect(names(filterLogins(logins, "bank", true))).toEqual([
      "https://bank.example finance",
    ]);
    expect(compromisedCount(logins)).toBe(2);
    expect(compromisedCount([login("https://a.example", "ana")])).toBe(0);
  });
  it("the import summary reads its counts in order", () => {
    expect(
      importSummaryLines({
        added: 3,
        unchanged: 2,
        kept: 1,
        replaced: 1,
        skipped: 4,
        neverSaved: 2,
        warnings: [],
      }),
    ).toEqual([
      "Imported 4 passwords.",
      "2 were already saved.",
      "1 differs from saved ones and was kept.",
      "4 rows were skipped.",
    ]);
    // Zero counts leave their line out.
    expect(
      importSummaryLines({
        added: 1,
        unchanged: 0,
        kept: 0,
        replaced: 0,
        skipped: 0,
        neverSaved: 0,
        warnings: [],
      }),
    ).toEqual(["Imported 1 password."]);
    expect(
      importSummaryLines({
        added: 0,
        unchanged: 1,
        kept: 2,
        replaced: 0,
        skipped: 1,
        neverSaved: 0,
        warnings: ["3 Chrome passwords couldn't be read."],
      }),
    ).toEqual([
      "Imported 0 passwords.",
      "1 was already saved.",
      "2 differ from saved ones and were kept.",
      "1 row was skipped.",
      "3 Chrome passwords couldn't be read.",
    ]);
  });
});

function savePrompt(fields: Partial<PasswordPrompt> = {}): PasswordPrompt {
  return {
    id: "pw1",
    tabId: "t1",
    kind: "save",
    host: "shop.example",
    username: "ana",
    ...fields,
  };
}
// A section 7 prompt, which asks for the same slot.
function sitePrompt(tabId: string): PendingPrompt {
  return {
    id: `s7-${tabId}`,
    spaceId: "personal",
    tabId,
    kind: "location",
    at: 1,
    agent: false,
  };
}
function shell(fields: Partial<BrowserState>): BrowserState {
  return { ...initialState(), activeTabId: "t1", ...fields };
}

describe("the password prompt in the bar", () => {
  it("the active tab shows its password prompt only without a section 7 prompt", () => {
    const mine = savePrompt();
    expect(
      shownPasswordPrompt(
        shell({
          passwordPrompts: [savePrompt({ id: "pw0", tabId: "t2" }), mine],
        }),
      ),
    ).toBe(mine);
    // A section 7 prompt for the active tab takes the slot.
    expect(
      shownPasswordPrompt(
        shell({ passwordPrompts: [mine], prompts: [sitePrompt("t1")] }),
      ),
    ).toBeUndefined();
    // One on another tab leaves this one alone.
    expect(
      shownPasswordPrompt(
        shell({ passwordPrompts: [mine], prompts: [sitePrompt("t2")] }),
      ),
    ).toBe(mine);
    expect(
      shownPasswordPrompt(
        shell({ passwordPrompts: [savePrompt({ tabId: "t2" })] }),
      ),
    ).toBeUndefined();
    expect(shownPasswordPrompt(shell({ passwordPrompts: [] }))).toBeUndefined();
  });
  it("password results are told apart from errors", () => {
    expect(
      isPasswordError({
        error: { code: "vault_locked", message: "Saved passwords are locked." },
      }),
    ).toBe(true);
    expect(isPasswordError({ ok: true })).toBe(false);
    expect(isPasswordError([])).toBe(false);
    expect(isPasswordError({ state: "ready", count: 2, compromised: 0 })).toBe(
      false,
    );
  });
});

function bar(prompt: PasswordPrompt): string {
  return renderToStaticMarkup(
    createElement(PasswordPromptBar, {
      prompt,
      onAnswer: async () => ({ ok: true }) as const,
    }),
  );
}

describe("the password prompt bar", () => {
  it("offers to save with an editable username and eight dots", () => {
    const markup = bar(savePrompt());
    expect(markup).toContain('class="prompt-bar');
    expect(markup).toContain('role="region"');
    expect(markup).toContain("Save password for <bdi>shop.example</bdi>?");
    expect(markup).toContain(">Username<");
    expect(markup).toContain('value="ana"');
    expect(markup).toContain('maxLength="1000"');
    expect(markup).toContain('dir="auto"');
    expect(markup).toContain("••••••••");
    expect(markup).toContain(">Save<");
    expect(markup).toContain(">Never for this site<");
    expect(markup).toContain(">Not now<");
    expect(markup).not.toContain(">Update<");
    expect(markup).not.toContain("disabled");
  });
  it("offers to update the saved password, with the username isolated", () => {
    const markup = bar(
      savePrompt({ id: "pw2", kind: "update", username: "عمر" }),
    );
    expect(markup).toContain(
      "Update password for <bdi>عمر</bdi> on <bdi>shop.example</bdi>?",
    );
    expect(markup).toContain(">Update<");
    expect(markup).toContain(">Not now<");
    expect(markup).not.toContain(">Never for this site<");
    expect(markup).not.toContain("<input");
  });
});
