// Google's result page: one navigation, a stop at any wall, then one read.
// Read only, like every tool in this pack: nothing signs in, opens a result
// or submits a form.

// The results area, and the one thing worth waiting for after the
// navigation. A page without it never showed results at all.
const RESULTS = "#search";

/**
 * The organic results of one search, in the order the page lists them.
 * @param {{ page: object }} context The agent page the tool works in.
 * @param {{ query: string, limit?: number }} args
 * @returns {Promise<{ title: string, url: string, snippet: string | null }[]>}
 */
export async function search({ page }, { query, limit = 10 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new RangeError("limit must be an integer from 1 to 20.");
  const landed = await page.goto(
    `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
  );
  // Where the navigation ended, read before anything on the page, so a wall
  // is handed to the person instead of being reported as no results.
  if (walled(landed?.tab?.url || page.url)) throw wall();
  await page.waitForSelector(RESULTS);
  const results = await page.evaluate(readResults);
  return results.slice(0, limit);
}

// The two addresses Google sends a space to when it wants the person: the
// consent host, and the verification path.
function walled(url) {
  let where;
  try {
    where = new URL(url);
  } catch {
    return false;
  }
  return (
    where.hostname === "consent.google.com" ||
    /^\/sorry(\/|$)/.test(where.pathname)
  );
}

const wall = () =>
  new Error(
    "Google is asking the person to choose or verify. Hand the space to the person, then run the tool again.",
  );

// Runs in the page, so it stands alone and reads only what the page shows:
// every organic result in the order the list holds them.
function readResults() {
  const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
  // The organic list. The ad slots and the related searches sit outside it,
  // so they are left out by reading inside it.
  const area =
    document.querySelector("#rso") ||
    document.querySelector("#search") ||
    document.body;
  // The blocks inside the list that hold something other than a result: the
  // ad slots, the question cards and the related searches.
  const ASIDE =
    '#tads,#tadsb,#bottomads,#botstuff,[data-text-ad],[data-initq],[jsname="yEVEwb"]';
  const aside = (node) => {
    for (let at = node; at && at !== area; at = at.parentElement)
      if (at.matches(ASIDE)) return true;
    return false;
  };
  // A result's address, with Google's own redirect link resolved to the page
  // it points at and everything else made absolute as it stands.
  const address = (href) => {
    const at = new URL(href, location.href);
    if (at.pathname === "/url") {
      const target = at.searchParams.get("q") || at.searchParams.get("url");
      if (target) return new URL(target, location.href).href;
    }
    return at.href;
  };
  const read = [];
  for (const title of area.querySelectorAll("a h3")) {
    const link = title.closest("a");
    const href = link.getAttribute("href");
    if (!href || aside(link)) continue;
    // The block the result is rendered into: the title's topmost ancestor
    // inside the list, which holds the snippet beside the title.
    let block = link;
    while (block.parentElement && block.parentElement !== area)
      block = block.parentElement;
    const snippet = block.querySelector("[data-sncf]");
    read.push({
      title: words(title),
      url: address(href),
      snippet: snippet ? words(snippet).slice(0, 300) : null,
    });
  }
  return read;
}
