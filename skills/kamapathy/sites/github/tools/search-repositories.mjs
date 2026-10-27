// GitHub's repository search: one navigation, then one read in the page.
// Read only, like every tool in this pack: nothing stars, follows, comments
// or submits a form.

// The list the search page renders its results into, and the one thing worth
// waiting for after the navigation.
const RESULTS = '[data-testid="results-list"]';

/**
 * The first page of repository results for a query.
 * @param {{ page: object }} context The agent page the tool works in.
 * @param {{ query: string, limit?: number }} args
 * @returns {Promise<{ fullName: string, url: string, description: string | null,
 *   stars: number | null, language: string | null }[]>}
 */
export async function searchRepositories({ page }, { query, limit = 10 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new RangeError("limit must be an integer from 1 to 50.");
  await page.goto(
    `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`,
  );
  await page.waitForSelector(RESULTS);
  const results = await page.evaluate(readResults);
  return results.slice(0, limit);
}

// Runs in the page, so it stands alone and reads only what the page shows:
// every result in the order the list holds them.
function readResults() {
  const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
  // A count as the page writes it, so "12.3k" reads 12300.
  const count = (text) => {
    const found = /^([\d.,]+)\s*([kmb])?$/i.exec(text);
    if (!found) return null;
    const base = Number(found[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[(found[2] || "").toLowerCase()];
    return Math.round(base * (scale || 1));
  };
  const read = [];
  for (const row of document.querySelectorAll(
    '[data-testid="results-list"] > div',
  )) {
    const link = row.querySelector(".search-title a");
    if (!link) continue;
    // The snippet is the row's own text: not the title, not a topic link and
    // not the footer that carries the language and the counts.
    const snippet = [...row.querySelectorAll("span")].find(
      (span) =>
        span.textContent.trim() &&
        !span.closest("h3") &&
        !span.closest("a") &&
        !span.closest("ul"),
    );
    const star = row.querySelector('a[href$="/stargazers"]');
    const language = row.querySelector('[aria-label$="language"]');
    read.push({
      fullName: link.textContent.replace(/\s+/g, ""),
      url: new URL(link.getAttribute("href"), location.href).href,
      description: snippet ? words(snippet).slice(0, 300) : null,
      stars: star ? count(words(star)) : null,
      language: language ? words(language) : null,
    });
  }
  return read;
}
