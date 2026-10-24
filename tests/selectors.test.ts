import { describe, expect, it } from "vitest";
import {
  AX_ROLES,
  DIGIT_ID_HINT,
  EDITABLE_ROLES,
  FORMS,
  MAX_SELECTOR,
  REF_HINT,
  axRoleValues,
  canonicalRole,
  normalizeText,
  parseSelector,
  roleWordFor,
  selectorError,
  type SelectorProblem,
} from "../electron/agent/selectors";
import { SELECTOR_FORMS } from "../skills/kamapathy/scripts/schema/index.mjs";

const ast = (selector: string) => {
  const parsed = parseSelector(selector);
  if (!parsed.ok)
    throw new Error(`${selector} did not parse: ${parsed.problem.message}`);
  return parsed.ast;
};
const problem = (selector: string): SelectorProblem => {
  const parsed = parseSelector(selector);
  if (parsed.ok) throw new Error(`${selector} parsed as ${parsed.ast.kind}`);
  return parsed.problem;
};

describe("selector grammar", () => {
  it("parses every selector form", () => {
    expect(ast("@e12")).toEqual({ kind: "ref", ref: "@e12" });
    expect(ast("form .save")).toEqual({
      kind: "css",
      css: "form .save",
      raw: true,
    });
    for (const selector of ["css=#save", "css:#save", "loc=css:#save"])
      expect(ast(selector), selector).toEqual({
        kind: "css",
        css: "#save",
        raw: false,
      });
    expect(ast("text=sign in")).toEqual({
      kind: "text",
      value: "sign in",
      exact: false,
    });
    for (const selector of ['text="Sign in"', "text='Sign in'"])
      expect(ast(selector), selector).toEqual({
        kind: "text",
        value: "Sign in",
        exact: true,
      });
    expect(ast('role=button[name="Save"]')).toEqual({
      kind: "role",
      role: "button",
      name: { value: "Save", match: "exact" },
    });
    expect(ast('role=link[name*="price"]')).toEqual({
      kind: "role",
      role: "link",
      name: { value: "price", match: "contains" },
    });
    expect(ast("role=checkbox")).toEqual({ kind: "role", role: "checkbox" });
    for (const selector of ["role:button", "loc=role:button"])
      expect(ast(selector), selector).toEqual({ kind: "role", role: "button" });
    expect(ast("role=button[name=Save changes]")).toEqual({
      kind: "role",
      role: "button",
      name: { value: "Save changes", match: "exact" },
    });
    expect(ast("href=/plans?tier=pro#faq")).toEqual({
      kind: "href",
      href: "/plans?tier=pro#faq",
    });
    for (const selector of ["href:/plans", "loc=href:/plans"])
      expect(ast(selector), selector).toEqual({
        kind: "href",
        href: "/plans",
      });
    for (const selector of ["xpath=//table//tr[2]", "//table//tr[2]"])
      expect(ast(selector), selector).toEqual({
        kind: "xpath",
        xpath: "//table//tr[2]",
      });
    expect(ast("../a")).toEqual({ kind: "xpath", xpath: "../a" });
    expect(ast('li:has-text("Invoice 12")')).toEqual({
      kind: "css",
      css: "li",
      raw: false,
      filter: { kind: "has-text", value: "Invoice 12" },
    });
    expect(ast('button:text-is("Save")')).toEqual({
      kind: "css",
      css: "button",
      raw: false,
      filter: { kind: "text-is", value: "Save" },
    });
    expect(ast("li:has-text('It\\'s ready')")).toEqual({
      kind: "css",
      css: "li",
      raw: false,
      filter: { kind: "has-text", value: "It's ready" },
    });
    expect(ast(':has-text("x")')).toEqual({
      kind: "css",
      css: "*",
      raw: false,
      filter: { kind: "has-text", value: "x" },
    });
    expect(ast('role=button[name="Delete"] >> nth=-1')).toEqual({
      kind: "role",
      role: "button",
      name: { value: "Delete", match: "exact" },
      nth: -1,
    });
    expect(ast("text=Next >> nth=0")).toEqual({
      kind: "text",
      value: "Next",
      exact: false,
      nth: 0,
    });
    expect(ast('a[title=">>"]')).toEqual({
      kind: "css",
      css: 'a[title=">>"]',
      raw: true,
    });
    for (const [word, role] of [
      ["textfield", "textbox"],
      ["ListBoxOption", "option"],
      ["menulistoption", "option"],
      ["image", "img"],
    ])
      expect(ast(`role=${word}`), word).toEqual({ kind: "role", role });
  });

  it("rejects malformed selectors before page work", () => {
    for (const selector of [
      "button:has-text(Save)",
      'a:has-text("x") b',
      'a, b:has-text("x")',
      "a >> b",
      "a >> nth=-2",
      'role=button[name^="x"]',
      "text=",
      "loc=text:x",
      "@e12 >> nth=0",
      "a".repeat(MAX_SELECTOR + 1),
    ])
      expect(problem(selector).reason, selector).toBe("grammar");
    // A message names the form, never the selector it was given.
    expect(problem('a:has-text("secret") b').message).not.toContain("secret");
    expect(problem("a".repeat(MAX_SELECTOR + 1)).message).not.toContain("aa");
    expect(REF_HINT).toBe("Refs look like @e21. Take one from a snapshot.");
    for (const selector of ["@21", "ref=21", "21", "@e0"])
      expect(problem(selector), selector).toEqual({
        reason: "ref_form",
        message: "This is not a ref. Refs look like @e21.",
        hint: REF_HINT,
      });
    expect(DIGIT_ID_HINT).toBe(
      'Write ids that start with a digit as [id="1abc"].',
    );
    for (const selector of ["#1abc", "css=div #2"])
      expect(problem(selector), selector).toEqual({
        reason: "css",
        message: "Ids that start with a digit are not valid CSS.",
        hint: DIGIT_ID_HINT,
      });
    expect(FORMS).toEqual(SELECTOR_FORMS.map((form) => form.example));
    const detailed = selectorError("#1abc", problem("#1abc"), 2);
    expect(detailed.status).toBe(400);
    expect(detailed.code).toBe("invalid_selector");
    expect(detailed.message).toBe(
      "Ids that start with a digit are not valid CSS.",
    );
    expect(detailed.fields).toEqual({
      selector: "#1abc",
      reason: "css",
      forms: FORMS,
      hint: DIGIT_ID_HINT,
      index: 2,
    });
    const plain = selectorError("a >> b", problem("a >> b"));
    expect(Object.keys(plain.fields)).toEqual(["selector", "reason", "forms"]);
    expect(plain.message).toBe(
      "Only one >> nth=N may end a selector, with N from 0, or -1 for the last match.",
    );
  });

  it("maps role words to Chromium's roles and back", () => {
    expect(canonicalRole("BUTTON")).toBe("button");
    expect(canonicalRole("textfield")).toBe("textbox");
    expect(canonicalRole("ListBoxOption")).toBe("option");
    expect(canonicalRole("menulistoption")).toBe("option");
    expect(canonicalRole("image")).toBe("img");
    expect(axRoleValues("img")).toEqual(["image"]);
    expect(axRoleValues("button")).toEqual([
      "button",
      "disclosuretriangle",
      "colorwell",
    ]);
    expect(axRoleValues("textbox")).toEqual([
      "textbox",
      "date",
      "datetime",
      "inputtime",
    ]);
    expect(axRoleValues("table")).toEqual(["table", "layouttable"]);
    expect(axRoleValues("row")).toEqual(["row", "layouttablerow"]);
    expect(axRoleValues("cell")).toEqual(["cell", "layouttablecell"]);
    expect(axRoleValues("link")).toEqual(["link"]);
    expect(roleWordFor("disclosuretriangle")).toBe("button");
    expect(roleWordFor("layouttablecell")).toBe("cell");
    expect(roleWordFor("image")).toBe("img");
    expect(roleWordFor("iframe")).toBe("iframe");
    expect(roleWordFor("Iframe")).toBe("iframe");
    expect(roleWordFor("sectionheader")).toBe("sectionheader");
    for (const [word, values] of Object.entries(AX_ROLES))
      for (const value of values) expect(roleWordFor(value), value).toBe(word);
    expect(EDITABLE_ROLES).toEqual(["textbox"]);
  });

  it("normalizes text", () => {
    expect(normalizeText("  Sign­up ​now\n  again ")).toBe("Signup now again");
    expect(normalizeText("  a\t\tb  ")).toBe("a b");
    expect(normalizeText("​­")).toBe("");
  });
});
