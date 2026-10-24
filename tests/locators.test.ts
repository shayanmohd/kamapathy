// The locator candidates a snapshot proposes, before any page work: their
// order, the values they refuse, and how they are written.
import { describe, expect, it } from "vitest";
import {
  cssIdentifier,
  cssString,
  generatedId,
  locatorCandidates,
  type LocatorSource,
} from "../electron/agent/locators";

const PAGE = "https://shop.example/cart?step=2";
const sourceOf = (source: Partial<LocatorSource>): LocatorSource => ({
  ref: "@e1",
  tag: "input",
  attributes: {},
  ...source,
});
const locatorsOf = (
  source: Partial<LocatorSource>,
  role?: { word: string; name: string },
) => locatorCandidates(sourceOf(source), PAGE, role).map((row) => row.locator);

describe("locator candidates", () => {
  it("skips generated ids", () => {
    for (const id of [
      ":r12:",
      "react-select-3-input",
      "item123",
      "a1b2c3d4",
      "ember42",
      "radix-99",
      "headlessui-menu-button-7",
      "mui-component",
      "yui_1",
      "ext-gen1",
    ])
      expect(generatedId(id), id).toBe(true);
    for (const id of [
      "save",
      "checkout-form",
      "email",
      "card_number",
      "step2",
      "h2",
    ])
      expect(generatedId(id), id).toBe(false);
  });

  it("orders candidates and refuses values it cannot write", () => {
    expect(
      locatorCandidates(
        sourceOf({
          attributes: {
            "data-testid": "card",
            "data-test": "card-field",
            "data-qa": "card-qa",
            "data-cy": "card-cy",
            id: "email",
            name: "email-field",
            "aria-label": "Email address",
            placeholder: "you@shop.example",
          },
        }),
        PAGE,
        { word: "textbox", name: "Email address" },
      ),
    ).toEqual([
      { locator: 'css=[data-testid="card"]', kind: "css" },
      { locator: 'css=[data-test="card-field"]', kind: "css" },
      { locator: 'css=[data-qa="card-qa"]', kind: "css" },
      { locator: 'css=[data-cy="card-cy"]', kind: "css" },
      { locator: "css=#email", kind: "css" },
      { locator: 'role=textbox[name="Email address"]', kind: "role" },
      { locator: 'css=input[name="email-field"]', kind: "css" },
      { locator: 'css=input[aria-label="Email address"]', kind: "css" },
      { locator: 'css=input[placeholder="you@shop.example"]', kind: "css" },
    ]);
    // A link's address comes after its role and before the attributes.
    expect(
      locatorsOf(
        {
          tag: "a",
          attributes: { id: "plans" },
          href: `${new URL(PAGE).origin}/plans?tier=pro#faq`,
        },
        { word: "link", name: "Plans" },
      ),
    ).toEqual([
      "css=#plans",
      'role=link[name="Plans"]',
      "href=/plans?tier=pro#faq",
    ]);
    // A generated id is skipped, and the next candidate stands.
    expect(locatorsOf({ attributes: { id: "item123", name: "size" } })).toEqual(
      ['css=input[name="size"]'],
    );
    // Values over 100 characters and values with control characters are
    // skipped, in the role name too.
    const long = "a".repeat(101);
    expect(
      locatorsOf(
        {
          attributes: {
            "data-testid": long,
            id: long,
            name: "two\nlines",
            "aria-label": "bell\u0007",
            placeholder: "ok",
          },
        },
        { word: "textbox", name: long },
      ),
    ).toEqual(['css=input[placeholder="ok"]']);
    expect(
      locatorsOf({ attributes: {} }, { word: "button", name: "" }),
    ).toEqual([]);
    // Attribute values are CSS strings, and ids are CSS identifiers.
    expect(
      locatorsOf({ attributes: { "data-testid": 'say "hi"\\ now' } }),
    ).toEqual(['css=[data-testid="say \\"hi\\"\\\\ now"]']);
    expect(cssString("plain")).toBe('"plain"');
    for (const [id, escaped] of [
      ["email", "email"],
      ["1abc", "\\31 abc"],
      ["-1a", "-\\31 a"],
      ["-", "\\-"],
      ["a.b", "a\\.b"],
      ["a b", "a\\ b"],
      ["café", "café"],
    ] as const)
      expect(cssIdentifier(id), id).toBe(escaped);
    expect(locatorsOf({ attributes: { id: "a.b" } })).toEqual(["css=#a\\.b"]);
  });

  it("uses path, query and hash for same-origin links", () => {
    const link = (href: string) =>
      locatorsOf({ tag: "a", attributes: {}, href });
    expect(link(`${new URL(PAGE).origin}/orders/4?from=list#top`)).toEqual([
      "href=/orders/4?from=list#top",
    ]);
    expect(link("https://other.example/pricing")).toEqual([
      "href=https://other.example/pricing",
    ]);
    expect(link("mailto:help@shop.example?subject=Order")).toEqual([
      "href=mailto:help@shop.example?subject=Order",
    ]);
    // Only links carry an address, and an address over 100 characters does
    // not fit a locator.
    expect(
      locatorsOf({
        tag: "area",
        attributes: {},
        href: `${new URL(PAGE).origin}/map`,
      }),
    ).toEqual([]);
    expect(link(`${new URL(PAGE).origin}/${"a".repeat(101)}`)).toEqual([]);
  });
});
