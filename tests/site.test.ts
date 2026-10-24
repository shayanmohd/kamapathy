import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const site = (file: string) =>
  readFileSync(new URL(`../site/${file}`, import.meta.url), "utf8");
const stamp = (file: string) =>
  createHash("sha256").update(site(file)).digest("hex").slice(0, 10);

// Cloudflare keeps CSS and JS for hours, so each page links them with a hash
// of their contents and a changed file gets a URL no cache has seen.
describe("website asset links", () => {
  for (const page of ["index.html", "404.html"])
    it(`${page} links the current styles and scripts`, () => {
      const html = site(page);
      const links = [...html.matchAll(/(?:href|src)="\/([\w-]+\.(?:css|js))(\?v=[\w]+)?"/g)];
      expect(links.length).toBeGreaterThan(0);
      for (const [, file, version] of links)
        expect(`${file}${version ?? ""}`).toBe(`${file}?v=${stamp(file)}`);
    });
});

const readme = () =>
  readFileSync(new URL("../README.md", import.meta.url), "utf8");

// What the person is promised about an agent at work, on both front pages.
const PROMISE =
  "A green ring, the agent's own cursor and a short status show what an agent is doing.";
const DIAGRAM =
  "K-->>Y: the ring, the cursor and the agent's status show every step";
const BULLET =
  "Agents show a short status, label their clicks, say when they cannot finish, and keep working after you close the window until you quit.";

describe("the agent promise", () => {
  it("the site and README promise the cursor and the status", () => {
    for (const [name, text] of [
      ["README.md", readme()],
      ["index.html", site("index.html")],
    ] as const) {
      expect(text, name).toContain(PROMISE);
      expect(text, name).not.toContain(
        "A green ring and a small bar show when an agent is working.",
      );
    }
    expect(readme()).toContain(DIAGRAM);
    expect(readme()).toContain(BULLET);
    // No product but Kamapathy is named in that promise.
    for (const sentence of [PROMISE, DIAGRAM, BULLET])
      for (const [word] of sentence.matchAll(/\b[A-Z][A-Za-z]+\b/gu))
        expect(["Agents", "Kamapathy"], sentence).toContain(word);
  });
});
