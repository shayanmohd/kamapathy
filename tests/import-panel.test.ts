import { describe, expect, it } from "vitest";
import type {
  ImportErrorCode,
  ImportOutcome,
  ImportSource,
} from "../shared/types";
import {
  blockedSources,
  doneLine,
  errorText,
  importRequest,
  initialSelection,
  passwordsAvailable,
  signInsAvailable,
  type ImportChoices,
  type Selection,
} from "../src/lib/import";
import { importCopy } from "../src/copy";

function source(id: string, extra: Partial<ImportSource> = {}): ImportSource {
  return {
    id,
    name: id,
    profiles: [{ id: "Default", name: "Person 1" }],
    default: false,
    signInsAvailable: true,
    passwordsAvailable: true,
    status: "ready",
    ...extra,
  };
}
const selection = (entries: [string, string[]][]): Selection =>
  new Map(entries.map(([id, profiles]) => [id, new Set(profiles)]));
const choices = (extra: Partial<ImportChoices> = {}): ImportChoices => ({
  selection: selection([["chrome", ["Default"]]]),
  bookmarks: true,
  history: true,
  signIns: false,
  passwords: false,
  destination: "shared",
  ...extra,
});
const outcome = (extra: Partial<ImportOutcome> = {}): ImportOutcome => ({
  bookmarks: 2,
  history: 3,
  signIns: 1,
  spaces: [],
  warnings: [],
  ...extra,
});

describe("initialSelection", () => {
  it("starts with the default browser's first profile", () => {
    const sources = [
      source("edge"),
      source("chrome", {
        default: true,
        profiles: [
          { id: "Profile 2", name: "Work" },
          { id: "Default", name: "Person 1" },
        ],
      }),
    ];
    expect(initialSelection(sources)).toEqual(
      new Map([["chrome", new Set(["Profile 2"])]]),
    );
  });

  it("falls back to the first ready source", () => {
    const sources = [source("edge"), source("chrome")];
    expect(initialSelection(sources)).toEqual(
      new Map([["edge", new Set(["Default"])]]),
    );
  });

  it("never preselects a blocked source or Safari", () => {
    const sources = [
      source("chrome", {
        default: true,
        status: "needs_permission",
        profiles: [],
      }),
      source("safari", { signInsAvailable: false }),
      source("firefox", { signInsAvailable: false }),
    ];
    expect(initialSelection(sources)).toEqual(
      new Map([["firefox", new Set(["Default"])]]),
    );
  });

  it("selects nothing when every source is blocked or Safari", () => {
    const sources = [
      source("chrome", { status: "needs_permission", profiles: [] }),
      source("safari"),
    ];
    expect(initialSelection(sources)).toEqual(new Map());
  });
});

describe("importRequest", () => {
  it("maps the selection to profiles", () => {
    const request = importRequest(
      choices({
        selection: selection([
          ["chrome", ["Default", "Profile 2"]],
          ["edge", ["Default"]],
        ]),
        history: false,
      }),
    );
    expect(request).toEqual({
      profiles: [
        { source: "chrome", profile: "Default" },
        { source: "chrome", profile: "Profile 2" },
        { source: "edge", profile: "Default" },
      ],
      bookmarks: true,
      history: false,
      signIns: "none",
    });
  });

  it("sends the destination only when sign-ins are chosen", () => {
    expect(importRequest(choices({ signIns: false }))?.signIns).toBe("none");
    expect(importRequest(choices({ signIns: true }))?.signIns).toBe("shared");
    expect(
      importRequest(choices({ signIns: true, destination: "separate" }))
        ?.signIns,
    ).toBe("separate");
  });

  it("imports sign-ins alone", () => {
    const request = importRequest(
      choices({ bookmarks: false, history: false, signIns: true }),
    );
    expect(request).toEqual({
      profiles: [{ source: "chrome", profile: "Default" }],
      bookmarks: false,
      history: false,
      signIns: "shared",
    });
  });

  it("sends the passwords the person asked for", () => {
    expect(importRequest(choices())?.passwords).toBeUndefined();
    expect(importRequest(choices({ passwords: true }))?.passwords).toBe(true);
    // Passwords on their own are enough to import.
    expect(
      importRequest(
        choices({ bookmarks: false, history: false, passwords: true }),
      ),
    ).toEqual({
      profiles: [{ source: "chrome", profile: "Default" }],
      bookmarks: false,
      history: false,
      signIns: "none",
      passwords: true,
    });
  });

  it("is null when nothing is selected", () => {
    expect(importRequest(choices({ selection: selection([]) }))).toBeNull();
    expect(
      importRequest(choices({ selection: selection([["chrome", []]]) })),
    ).toBeNull();
  });

  it("is null when nothing is to be imported", () => {
    expect(
      importRequest(choices({ bookmarks: false, history: false })),
    ).toBeNull();
  });
});

describe("signInsAvailable", () => {
  it("needs a selected source that has sign-ins", () => {
    const sources = [
      source("chrome"),
      source("firefox", { signInsAvailable: false }),
    ];
    expect(
      signInsAvailable(sources, selection([["firefox", ["Default"]]])),
    ).toBe(false);
    expect(
      signInsAvailable(sources, selection([["chrome", ["Default"]]])),
    ).toBe(true);
    expect(signInsAvailable(sources, selection([["chrome", []]]))).toBe(false);
    expect(signInsAvailable(sources, selection([]))).toBe(false);
  });
});

describe("passwordsAvailable", () => {
  it("needs a selected source that has passwords", () => {
    const sources = [
      source("chrome"),
      source("firefox", { passwordsAvailable: false }),
    ];
    expect(
      passwordsAvailable(sources, selection([["firefox", ["Default"]]])),
    ).toBe(false);
    expect(
      passwordsAvailable(sources, selection([["chrome", ["Default"]]])),
    ).toBe(true);
    expect(passwordsAvailable(sources, selection([["chrome", []]]))).toBe(
      false,
    );
    expect(passwordsAvailable(sources, selection([]))).toBe(false);
  });
});

describe("blockedSources", () => {
  it("lists the sources waiting for permission", () => {
    const blocked = source("chrome", {
      status: "needs_permission",
      profiles: [],
    });
    expect(blockedSources([source("edge"), blocked])).toEqual([blocked]);
    expect(blockedSources([source("edge")])).toEqual([]);
  });
});

describe("doneLine", () => {
  it("keeps the line without sign-ins", () => {
    expect(doneLine(outcome(), false)).toBe(
      "Imported 2 bookmarks and 3 sites.",
    );
    expect(doneLine(outcome({ bookmarks: 1, history: 1 }), false)).toBe(
      "Imported 1 bookmark and 1 site.",
    );
  });

  it("adds the sign-ins with them", () => {
    expect(doneLine(outcome(), true)).toBe(
      "Imported 2 bookmarks, 3 sites and 1 sign-in.",
    );
    expect(doneLine(outcome({ signIns: 4 }), true)).toBe(
      "Imported 2 bookmarks, 3 sites and 4 sign-ins.",
    );
    expect(
      doneLine(outcome({ bookmarks: 1, history: 1, signIns: 0 }), true),
    ).toBe("Imported 1 bookmark, 1 site and 0 sign-ins.");
  });

  it("adds the passwords only when some came in", () => {
    expect(doneLine(outcome({ passwords: 0 }), false)).toBe(
      "Imported 2 bookmarks and 3 sites.",
    );
    expect(doneLine(outcome({ passwords: 4 }), false)).toBe(
      "Imported 2 bookmarks, 3 sites and 4 passwords.",
    );
    expect(doneLine(outcome({ passwords: 1 }), true)).toBe(
      "Imported 2 bookmarks, 3 sites, 1 sign-in and 1 password.",
    );
  });
});

describe("errorText", () => {
  const codes: ImportErrorCode[] = [
    "import_invalid_request",
    "source_not_found",
    "profile_not_found",
    "import_busy",
    "read_blocked",
    "keychain_denied",
    "cookies_unavailable",
    "invalid_archive",
  ];

  it("maps every code to the panel's text", () => {
    for (const code of codes)
      expect(errorText({ code, message: "from main" })).toBe(
        code === "invalid_archive" ? "from main" : importCopy.errors[code],
      );
    expect(Object.keys(importCopy.errors).sort()).toEqual([...codes].sort());
  });

  it("keeps the server's message for an unknown code", () => {
    expect(
      errorText({
        code: "something_else" as ImportErrorCode,
        message: "from main",
      }),
    ).toBe("from main");
  });
});
