// The selector grammar's forms, as the server's forms field and help list
// them. Only the documented spellings appear; css:, role:, href: and loc=
// stay accepted aliases.

export const SELECTOR_FORMS = [
  { form: "ref", example: "@e12", matches: "Its snapshot element; no search" },
  {
    form: "css",
    example: "form .save",
    matches: "CSS in the document and each open shadow root, each tree alone",
  },
  { form: "css=", example: "css=#save", matches: "The same" },
  {
    form: "text=",
    example: "text=sign in",
    matches:
      "Innermost elements whose text contains it, ignoring case and extra spaces",
  },
  {
    form: "text= quoted",
    example: 'text="Sign in"',
    matches: "Elements with an own text run equal to it",
  },
  {
    form: "role=",
    example: 'role=button[name="Save"]',
    matches:
      'Chromium\'s computed role with that exact accessible name; [name*="..."] takes part of the name, ignoring case, and no name takes any',
  },
  {
    form: "href=",
    example: "href=/plans?tier=pro#faq",
    matches: "Links whose path, query and hash, or whole URL, equals it",
  },
  {
    form: "xpath=",
    example: "xpath=//table//tr[2]",
    matches:
      "Elements from document.evaluate in each document, not in shadow roots; a leading // or .. works too",
  },
  {
    form: ":has-text",
    example: 'li:has-text("Invoice 12")',
    matches:
      "CSS matches whose text, shadow content included, contains it, ignoring case",
  },
  {
    form: ":text-is",
    example: 'button:text-is("Save")',
    matches: "CSS matches with an own text run equal to it",
  },
  {
    form: ">> nth=",
    example: 'role=button[name="Delete"] >> nth=-1',
    matches: "The Nth match in search order, from 0; -1 is the last",
  },
];
