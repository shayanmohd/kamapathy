import { SELECTOR_FORMS } from "../../skills/kamapathy/scripts/schema/index.mjs";
import { ApiError } from "./errors";

// The selector grammar, parsed in the main process before any page work:
// one AST per form, or a typed problem. Pure: no Electron, no Node, no page
// code. It also holds the text normalization and the role word tables that
// keep role=, locators and the outline's role words in agreement.

export type NameMatch = { value: string; match: "exact" | "contains" };
export type TextFilter = { kind: "has-text" | "text-is"; value: string };
export type SelectorAst =
  | { kind: "ref"; ref: string }
  | {
      kind: "css";
      css: string;
      raw: boolean;
      filter?: TextFilter;
      nth?: number;
    }
  | { kind: "text"; value: string; exact: boolean; nth?: number }
  | { kind: "role"; role: string; name?: NameMatch; nth?: number }
  | { kind: "href"; href: string; nth?: number }
  | { kind: "xpath"; xpath: string; nth?: number };
export type SearchAst = Exclude<SelectorAst, { kind: "ref" }>;
export type SelectorReason = "grammar" | "ref_form" | "css" | "xpath";
export interface SelectorProblem {
  reason: SelectorReason;
  message: string;
  hint?: string;
}
export type ParsedSelector =
  | { ok: true; ast: SelectorAst }
  | { ok: false; problem: SelectorProblem };

export const MAX_SELECTOR = 2048;
export const REF_HINT = "Refs look like @e21. Take one from a snapshot.";
export const DIGIT_ID_HINT =
  'Write ids that start with a digit as [id="1abc"].';
export const FORMS: readonly string[] = SELECTOR_FORMS.map(
  (row) => row.example,
);

const NTH_PROBLEM =
  "Only one >> nth=N may end a selector, with N from 0, or -1 for the last match.";
const REF_NTH_PROBLEM = "A ref names one element and takes no >> nth=.";
const NOT_A_REF = "This is not a ref. Refs look like @e21.";
const FILTER_PROBLEM =
  'Write :has-text("...") or :text-is("...") once, with one quoted argument, at the end of a CSS selector.';
const COMMA_PROBLEM =
  "A selector that ends in :has-text or :text-is cannot hold a top-level comma.";
const DIGIT_ID_PROBLEM = "Ids that start with a digit are not valid CSS.";
const LOC_PROBLEM =
  "Unknown loc= form. Use css=, text=, role=, href= or xpath=.";
const TEXT_PROBLEM = "text= needs some text.";
const TEXT_QUOTE_PROBLEM =
  "A quoted text= value must be one complete quoted string.";
const ROLE_PROBLEM =
  'Write role=<role>, role=<role>[name="..."] or role=<role>[name*="..."].';

// Role words agents write, lowercased, that name a different role here.
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  textfield: "textbox",
  listboxoption: "option",
  menulistoption: "option",
  image: "img",
};
// The lowercased role values Chromium reports for each role word. Values
// outside this table stand for themselves. button covers summary and color
// inputs, textbox the date and time inputs, and the table words their
// layout counterparts, so role= matches what the outline prints.
export const AX_ROLES: Readonly<Record<string, readonly string[]>> = {
  img: ["image"],
  button: ["button", "disclosuretriangle", "colorwell"],
  textbox: ["textbox", "date", "datetime", "inputtime"],
  table: ["table", "layouttable"],
  row: ["row", "layouttablerow"],
  cell: ["cell", "layouttablecell"],
};
// Roles that also match an editing host, which Chromium reports as generic
// with an editable property.
export const EDITABLE_ROLES: readonly string[] = ["textbox"];
const ROLE_WORDS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(AX_ROLES).flatMap(([word, values]) =>
    values.map((value) => [value, word]),
  ),
);

export function canonicalRole(word: string): string {
  const lower = word.toLowerCase();
  return ROLE_ALIASES[lower] ?? lower;
}
export function axRoleValues(role: string): readonly string[] {
  return AX_ROLES[role] ?? [role];
}
export function roleWordFor(axRole: string): string {
  const lower = axRole.toLowerCase();
  return ROLE_WORDS[lower] ?? lower;
}

export function normalizeText(text: string): string {
  return text
    .replace(/[\u200b\u00ad]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function selectorError(
  selector: string,
  problem: SelectorProblem,
  index?: number,
): ApiError {
  return new ApiError("invalid_selector", problem.message, {
    selector,
    reason: problem.reason,
    forms: FORMS,
    ...(problem.hint === undefined ? {} : { hint: problem.hint }),
    ...(index === undefined ? {} : { index }),
  });
}

const parsed = (ast: SelectorAst): ParsedSelector => ({ ok: true, ast });
const problem = (
  reason: SelectorReason,
  message: string,
  hint?: string,
): ParsedSelector => ({
  ok: false,
  problem: { reason, message, ...(hint === undefined ? {} : { hint }) },
});

// Walks the positions of text that sit outside quoted strings and outside
// [] or () nesting, stopping at the first one visit accepts. Returns that
// position, or -1.
function findTop(text: string, visit: (index: number) => boolean): number {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && visit(index)) return index;
  }
  return -1;
}

// Reads one quoted value from the start of text: a JSON string in double
// quotes, or single quotes with \' and \\ as the only escapes.
function readQuoted(text: string): { value: string; end: number } | undefined {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return undefined;
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (quote === "'" && next !== "'" && next !== "\\") return undefined;
      index++;
      continue;
    }
    if (char !== quote) continue;
    const raw = text.slice(0, index + 1);
    if (quote === "'")
      return {
        value: raw.slice(1, -1).replace(/\\(['\\])/g, "$1"),
        end: index + 1,
      };
    try {
      return { value: JSON.parse(raw) as string, end: index + 1 };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const PREFIXES: readonly (readonly [string, SearchAst["kind"]])[] = [
  ["css=", "css"],
  ["css:", "css"],
  ["loc=css:", "css"],
  ["text=", "text"],
  ["role=", "role"],
  ["role:", "role"],
  ["loc=role:", "role"],
  ["href=", "href"],
  ["href:", "href"],
  ["loc=href:", "href"],
  ["xpath=", "xpath"],
];
const REF = /^@e[1-9][0-9]*$/;
const REF_SHAPED = [/^@e[0-9]+$/, /^@[0-9]+$/, /^ref=/, /^[0-9]+$/];
const NTH_TAIL = /^\s*nth=(-1|0|[1-9][0-9]{0,5})$/;
const FILTERS = [":has-text(", ":text-is("] as const;

export function parseSelector(selector: string): ParsedSelector {
  const whole = selector.trim();
  if (!whole) return problem("grammar", "A selector cannot be empty.");
  if (whole.length > MAX_SELECTOR)
    return problem(
      "grammar",
      `A selector may be at most ${MAX_SELECTOR} characters.`,
    );
  const prefix = PREFIXES.find(([text]) => whole.startsWith(text));
  let kind: SearchAst["kind"];
  let body: string;
  if (prefix) {
    kind = prefix[1];
    body = whole.slice(prefix[0].length);
  } else if (whole.startsWith("loc=")) {
    return problem("grammar", LOC_PROBLEM);
  } else if (whole.startsWith("//") || whole.startsWith("..")) {
    kind = "xpath";
    body = whole;
  } else {
    kind = "css";
    body = whole;
  }

  // The final nth. An unquoted text= value may hold anything, so it splits
  // at its first >>; every other body splits outside quotes and nesting.
  const quotedText = kind === "text" && /^\s*["']/.test(body);
  const at =
    kind === "text" && !quotedText
      ? body.indexOf(">>")
      : findTop(body, (index) => body.startsWith(">>", index));
  let head = body;
  let nth: number | undefined;
  if (at >= 0) {
    const tail = NTH_TAIL.exec(body.slice(at + 2));
    head = body.slice(0, at);
    if (!tail || !head.trim()) return problem("grammar", NTH_PROBLEM);
    nth = Number(tail[1]);
  }
  const value = head.trim();

  if (!prefix && kind === "css") {
    if (REF.test(value))
      return nth === undefined
        ? parsed({ kind: "ref", ref: value })
        : problem("grammar", REF_NTH_PROBLEM);
    if (REF_SHAPED.some((shape) => shape.test(value)))
      return problem("ref_form", NOT_A_REF, REF_HINT);
  }

  if (kind === "css") return cssAst(value, !prefix, nth);
  if (kind === "text") return textAst(value, quotedText, nth);
  if (kind === "role") return roleAst(value, nth);
  if (!value)
    return problem(
      "grammar",
      kind === "href" ? "href= needs a path or URL." : "xpath= needs a path.",
    );
  return parsed(
    kind === "href"
      ? { kind: "href", href: value, ...(nth === undefined ? {} : { nth }) }
      : { kind: "xpath", xpath: value, ...(nth === undefined ? {} : { nth }) },
  );
}

function cssAst(
  body: string,
  bare: boolean,
  nth: number | undefined,
): ParsedSelector {
  if (!body) return problem("grammar", "A CSS selector cannot be empty.");
  let css = body;
  let filter: TextFilter | undefined;
  const at = findTop(body, (index) =>
    FILTERS.some((token) => body.startsWith(token, index)),
  );
  if (at >= 0) {
    const token = FILTERS.find((item) => body.startsWith(item, at)) ?? "";
    const quoted = readQuoted(body.slice(at + token.length));
    if (!quoted || body.slice(at + token.length + quoted.end) !== ")")
      return problem("grammar", FILTER_PROBLEM);
    filter = {
      kind: token.slice(1, -1) as TextFilter["kind"],
      value: quoted.value,
    };
    css = body.slice(0, at).trim() || "*";
    if (findTop(css, (index) => css[index] === ",") >= 0)
      return problem("grammar", COMMA_PROBLEM);
  }
  // An id starting with a digit is certain to fail in the page, so it is
  // worth naming here, with the hint. Other CSS problems the page reports.
  if (
    findTop(
      css,
      (index) => css[index] === "#" && /[0-9]/.test(css[index + 1] ?? ""),
    ) >= 0
  )
    return problem("css", DIGIT_ID_PROBLEM, DIGIT_ID_HINT);
  return parsed({
    kind: "css",
    css,
    raw: bare && !filter,
    ...(filter === undefined ? {} : { filter }),
    ...(nth === undefined ? {} : { nth }),
  });
}

function textAst(
  body: string,
  quoted: boolean,
  nth: number | undefined,
): ParsedSelector {
  let value = body;
  if (quoted) {
    const read = readQuoted(body);
    if (!read || read.end !== body.length)
      return problem("grammar", TEXT_QUOTE_PROBLEM);
    value = read.value;
  }
  if (!normalizeText(value)) return problem("grammar", TEXT_PROBLEM);
  return parsed({
    kind: "text",
    value,
    exact: quoted,
    ...(nth === undefined ? {} : { nth }),
  });
}

function roleAst(body: string, nth: number | undefined): ParsedSelector {
  const word = /^[A-Za-z]+/.exec(body);
  if (!word) return problem("grammar", ROLE_PROBLEM);
  const role = canonicalRole(word[0]);
  let rest = body.slice(word[0].length);
  let name: NameMatch | undefined;
  if (rest) {
    const start = /^\[name(\*?)=/.exec(rest);
    if (!start) return problem("grammar", ROLE_PROBLEM);
    const match = start[1] ? "contains" : "exact";
    rest = rest.slice(start[0].length);
    // Exact names stay as written: Chromium compares them case-sensitively
    // and its computed names keep U+00A0, U+00AD and U+200B.
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quoted = readQuoted(rest);
      if (!quoted || rest.slice(quoted.end) !== "]")
        return problem("grammar", ROLE_PROBLEM);
      name = { value: quoted.value, match };
    } else {
      const close = rest.indexOf("]");
      if (close !== rest.length - 1) return problem("grammar", ROLE_PROBLEM);
      name = { value: rest.slice(0, close).trim(), match };
    }
  }
  return parsed({
    kind: "role",
    role,
    ...(name === undefined ? {} : { name }),
    ...(nth === undefined ? {} : { nth }),
  });
}
