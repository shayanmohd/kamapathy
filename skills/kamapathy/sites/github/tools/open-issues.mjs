// A repository's open issues, read from the issues list. Read only: nothing
// opens, closes, labels or comments on an issue.

// What GitHub accepts as an account and a repository name, checked here so a
// typo never becomes a navigation.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
// The list the issues page renders its rows into.
const LIST = '[data-testid="issues-list-surface"]';

/**
 * The open issues of one repository, newest first as the page orders them.
 * @param {{ page: object }} context The agent page the tool works in.
 * @param {{ owner: string, repo: string, limit?: number }} args
 * @returns {Promise<{ number: number, title: string, url: string, labels: string[] }[]>}
 */
export async function openIssues({ page }, { owner, repo, limit = 25 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new RangeError("limit must be an integer from 1 to 50.");
  if (!OWNER.test(owner))
    throw new RangeError(
      "owner must be a GitHub account: letters, digits and inner hyphens, up to 39 characters.",
    );
  if (!REPO.test(repo))
    throw new RangeError(
      "repo must be a GitHub repository name: letters, digits, dots, hyphens and underscores, up to 100 characters.",
    );
  const landed = await page.goto(
    `https://github.com/${owner}/${repo}/issues?q=is%3Aissue%20state%3Aopen`,
  );
  if (landed && landed.httpStatus === 404) throw hidden(owner, repo);
  try {
    await page.waitForSelector(LIST);
  } catch (error) {
    // A page that never shows the list is answered by the read below, which
    // says whether the repository is there at all.
    if (error?.code !== "wait_timeout") throw error;
  }
  const read = await page.evaluate(readIssues);
  if (read.missing) throw hidden(owner, repo);
  return read.issues.slice(0, limit);
}

// A repository this space cannot see: it may not exist, or it may be private
// to an account the space is not signed in to.
const hidden = (owner, repo) =>
  new Error(
    `GitHub shows no repository ${owner}/${repo} to this space. Check the name, or sign in if it is private.`,
  );

// Runs in the page, so it stands alone: every row of the list, and whether
// the page GitHub answered is its "not found" page instead.
function readIssues() {
  const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
  const surface = document.querySelector('[data-testid="issues-list-surface"]');
  const issues = [];
  for (const link of surface
    ? surface.querySelectorAll('a[data-testid="issue-listitem-title-link"]')
    : []) {
    const address = new URL(link.getAttribute("href"), location.href);
    const found = /\/issues\/(\d+)$/.exec(address.pathname);
    if (!found) continue;
    const row = link.closest("li") || link.parentElement;
    const labels = [];
    for (const button of row.querySelectorAll(
      'button[aria-label^="Filter by label"]',
    )) {
      const text = words(button);
      if (text) labels.push(text);
    }
    issues.push({
      number: Number(found[1]),
      title: words(link),
      url: address.href,
      labels,
    });
  }
  return { missing: /page not found/i.test(document.title), issues };
}
