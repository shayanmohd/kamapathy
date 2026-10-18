import { describe, expect, it } from "vitest";
import type { SavedLoginSummary } from "../shared/types";
import {
  compromisedCount,
  filterLogins,
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
});
