// Accounts from the people tab of X's search, read from the cards it lists.
// Read only, like every tool in this pack: nothing follows, messages, blocks
// or posts.

// The column the page lists its cards in, and the one thing worth waiting
// for after the navigation.
const COLUMN = '[data-testid="primaryColumn"]';
// The same round shape the timeline tool uses, with ten rounds instead of
// thirty: search answers fewer screens than a timeline does.
const ROUNDS = 10;
const QUIET = 3;
const PIXELS = 800;
const SETTLE = 700;

/**
 * The accounts one search answers, in the order the page lists them.
 * @param {{ page: object }} context The agent page the tool works in.
 * @param {{ query: string, limit?: number }} args
 * @returns {Promise<{ name: string, handle: string, url: string, bio: string }[]>}
 */
export async function searchPeople({ page }, { query, limit = 20 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new RangeError("limit must be an integer from 1 to 50.");
  const landed = await page.goto(
    `https://x.com/search?q=${encodeURIComponent(query)}&f=user`,
  );
  // Where the navigation ended and what X answered, both read before
  // anything on the page, so a wall is handed to the person instead of
  // being reported as no accounts.
  if (walled(landed?.tab?.url || page.url) || landed?.httpStatus === 403)
    throw wall();
  await page.waitForSelector(COLUMN);
  const accounts = new Map();
  let quiet = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round) {
      await page.scroll("down", PIXELS);
      // X draws the next cards once the list has been moved.
      await page.waitForTimeout(SETTLE);
    }
    const read = await page.evaluate(readAccounts);
    const before = accounts.size;
    for (const account of read)
      if (account.url && !accounts.has(account.url) && accounts.size < limit)
        accounts.set(account.url, account);
    if (accounts.size >= limit) break;
    quiet = accounts.size > before ? 0 : quiet + 1;
    if (quiet >= QUIET) break;
  }
  return [...accounts.values()];
}

// The address X sends a space to when it wants the person to sign in. The
// other refusal is read beside this one, from the navigation's own status: X
// answers some spaces a bare 403 with an empty page.
function walled(url) {
  let where;
  try {
    where = new URL(url);
  } catch {
    return false;
  }
  return /^\/i\/flow\/login(\/|$)/.test(where.pathname);
}

const wall = () =>
  new Error(
    "X needs the person to sign in. Hand the space to the person, then run the tool again.",
  );

// Runs in the page, so it stands alone: every account card the list holds,
// in the order it holds them.
function readAccounts() {
  const words = (node) =>
    node ? node.textContent.replace(/\s+/g, " ").trim() : "";
  const area =
    document.querySelector('[data-testid="primaryColumn"]') || document.body;
  const read = [];
  for (const cell of area.querySelectorAll('[data-testid="UserCell"]')) {
    // A card links to the profile around the display name and again around
    // the handle, beside links to pages of its own such as the avatar.
    const links = [];
    for (const anchor of cell.querySelectorAll("a[href]")) {
      const at = new URL(anchor.getAttribute("href"), location.href);
      const parts = at.pathname.split("/").filter(Boolean);
      if (parts.length === 1 && /^[A-Za-z0-9_]{1,20}$/.test(parts[0]))
        links.push({ anchor, at, handle: parts[0] });
    }
    if (!links.length) continue;
    const { at, handle } = links[0];
    // The display name is the first of those links holding anything other
    // than the handle, whether or not the card keeps them apart.
    let name = "";
    for (const link of links) {
      const text = words(link.anchor).split(`@${handle}`).join("").trim();
      if (text) {
        name = text;
        break;
      }
    }
    read.push({
      name,
      handle: `@${handle}`,
      url: at.href,
      bio: words(cell.querySelector('[data-testid="UserDescription"]')).slice(
        0,
        300,
      ),
    });
  }
  return read;
}
