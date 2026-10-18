import { describe, expect, it } from "vitest";
import type { SavedLoginSummary } from "../shared/types";
import {
  compromisedCount,
  filterLogins,
  importSummaryLines,
  loginHost,
  sortLogins,
} from "../src/lib/passwords";

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
