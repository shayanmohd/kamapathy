import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { surfaceColor } from "../shared/theme";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function declarations(selector: string): Record<string, string> {
  const rule = `${selector} {`;
  const start = css.indexOf(rule) + rule.length;
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/([a-z-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

describe("visual tokens", () => {
  it("uses the approved light and dark values", () => {
    expect(tokens(":root")).toMatchObject({
      surface: "#ffffff",
      raised: "#f5f5f4",
      text: "#1a1a1a",
      secondary: "#6b6b6b",
      hairline: "#e7e7e5",
      accent: "#2f6b4f",
    });
    expect(tokens(':root[data-theme="dark"]')).toMatchObject({
      surface: "#1c1c1c",
      raised: "#252525",
      text: "#f2f2f2",
      secondary: "#a3a3a3",
      hairline: "#333333",
      accent: "#5fae88",
    });
  });
  it("paints the native window with the surface colour", () => {
    expect(tokens(":root").surface).toBe(surfaceColor.light);
    expect(tokens(':root[data-theme="dark"]').surface).toBe(surfaceColor.dark);
  });
  it("uses the system font at 13px", () => {
    expect(css).not.toContain("Geist");
    expect(css).toMatch(/:root \{[^}]*font:\s*13px\/1\.4 -apple-system/);
  });
});

const componentCss = readdirSync(new URL("../src/components/", import.meta.url))
  .filter((name) => name.endsWith(".css"))
  .map((name) =>
    readFileSync(new URL(`../src/components/${name}`, import.meta.url), "utf8"),
  );

describe("accent use", () => {
  it("keeps the accent for rings, focus and space state", () => {
    const allowed =
      /focus|selected|\.on\b|active|current|online|checked|pressed|space-trigger|agent-ring|agent-glow|agent-indicator|brand-mark/;
    const offenders = [css, ...componentCss].flatMap((text) =>
      [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, , body]) => body.includes("var(--accent)"))
        .map(([, selector]) => selector.trim())
        .filter((selector) => !allowed.test(selector)),
    );
    expect(offenders).toEqual([]);
  });
});

const shellSources = ["", "components/"].flatMap((folder) =>
  readdirSync(new URL(`../src/${folder}`, import.meta.url))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => ({
      name: `${folder}${name}`,
      text: readFileSync(
        new URL(`../src/${folder}${name}`, import.meta.url),
        "utf8",
      ),
    })),
);

describe("agent text", () => {
  it("is quoted, italic and secondary", () => {
    const rule = declarations(".agent-text");
    expect(rule["font-style"]).toBe("italic");
    expect(rule.color).toBe("var(--secondary)");
    expect(rule.quotes).toContain("\\201c");
    expect(rule.quotes).toContain("\\201d");
    expect(declarations(".agent-text::before").content).toBe("open-quote");
    expect(declarations(".agent-text::after").content).toBe("close-quote");
    const uses = shellSources.flatMap(({ name, text }) =>
      [...text.matchAll(/agent-text/g)].map((match) => {
        const tag = text.slice(
          text.lastIndexOf("<", match.index),
          text.indexOf(">", match.index) + 1,
        );
        return {
          name,
          element: /^<([A-Za-z]+)/.exec(tag)?.[1] ?? "",
          live: /role="status"|aria-live/.test(tag),
        };
      }),
    );
    expect(uses.length).toBeGreaterThan(0);
    // An agent's words are plain text beside Kamapathy's own: never a
    // button, link, field or dialog of its own, and never announced.
    expect(
      uses.filter(
        ({ element, live }) => live || !["p", "span"].includes(element),
      ),
    ).toEqual([]);
  });
});

describe("theme previews", () => {
  it("draw the current light and dark palettes", () => {
    const palette = [
      ...Object.values(tokens(":root")),
      ...Object.values(tokens(':root[data-theme="dark"]')),
    ];
    const colours = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector.includes("theme-preview"))
      .flatMap(([, , body]) => body.match(/#[0-9a-f]{3,8}\b/gi) ?? []);
    expect(colours.length).toBeGreaterThan(0);
    expect(colours.filter((colour) => !palette.includes(colour))).toEqual([]);
  });
});
