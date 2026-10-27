// The pages the github sample pack is measured against: a repository search
// with three results, a repository page, an issues list and the page GitHub
// answers for a repository nobody can see. Each one is hand written and
// carries only the attributes the pack's tools read, in the structure the
// live pages had when the pack's selectors were settled.
const head = (title) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>`;

// A description longer than the 300 characters a result keeps.
const long = `${"A long description that says the same thing again and again. ".repeat(6)}The end.`;

export const githubPages = {
  "/search": `${head("Repository search results &middot; GitHub")}
<div data-testid="results-list">
  <div>
    <h3><div><div class="search-title"><a href="/shayanmohd/kamapathy"><span>shayanmohd/<em>kamapathy</em></span></a></div></div></h3>
    <div><span>A calm desktop browser you share with your agents.</span></div>
    <div><div><a href="/topics/electron">electron</a></div><div><a href="/topics/browser">browser</a></div></div>
    <ul>
      <li><span aria-label="TypeScript language">TypeScript</span></li>
      <li><a href="/shayanmohd/kamapathy/stargazers">12.3k</a></li>
      <li>Updated <relative-time datetime="2026-10-20T09:30:00Z">on Oct 20, 2026</relative-time></li>
    </ul>
  </div>
  <div>
    <h3><div><div class="search-title"><a href="/second/repo"><span>second/<em>repo</em></span></a></div></div></h3>
    <ul>
      <li><span aria-label="JavaScript language">JavaScript</span></li>
      <li><a href="/second/repo/stargazers">948</a></li>
      <li>Updated <relative-time datetime="2026-09-01T12:00:00Z">on Sep 1, 2026</relative-time></li>
    </ul>
  </div>
  <div>
    <h3><div><div class="search-title"><a href="/third/repo"><span>third/<em>repo</em></span></a></div></div></h3>
    <div><span>${long}</span></div>
    <ul>
      <li>Updated <relative-time datetime="2026-08-11T08:00:00Z">on Aug 11, 2026</relative-time></li>
    </ul>
  </div>
</div>`,
  "/owner/repo": `${head("owner/repo: Notes and tools for one site &middot; GitHub")}
<div><div data-testid="repo-name-wrapper"><strong><a data-testid="repo-name-link" href="/owner/repo">repo</a></strong></div><span>Public</span></div>
<div>
  <div><h2><span>About</span></h2>
    <p>Notes and tools for one site, read by an agent before it starts.</p>
    <div><a href="/topics/site-packs">site-packs</a><a href="/topics/agents">agents</a><a href="/topics/agents">agents</a></div>
  </div>
  <div><h2>Stars</h2><div><span>12.3k stars</span></div></div>
  <div><h2>Watchers</h2><div><span>31 watching</span></div></div>
  <div><h2>Forks</h2><div><a href="/owner/repo/forks">481 forks</a></div></div>
  <div><h2>Languages</h2>
    <a href="/owner/repo/search?l=typescript"><span></span><span>TypeScript</span></a>
    <a href="/owner/repo/search?l=css"><span></span><span>CSS</span></a>
  </div>
</div>`,
  "/owner/repo/issues": `${head("Issues &middot; owner/repo &middot; GitHub")}
<div data-testid="issues-list-surface">
  <ul>
    <li>
      <div><h3><a href="https://github.com/owner/repo/issues/412" data-testid="issue-listitem-title-link"><span><span>Snapshot refs go stale between reads</span></span></a></h3>
        <span><button type="button" aria-label="Filter by label bug"><span><span>bug</span></span></button><button type="button" aria-label="Filter by label help wanted"><span><span>help wanted</span></span></button></span>
      </div>
      <div><span>owner/repo#412</span><span> &middot; <button type="button" data-testid="author-filter-link"><span>Filter by author </span>someone</button> <span>opened</span> <relative-time datetime="2026-10-24T11:00:00Z">on Oct 24, 2026</relative-time></span></div>
    </li>
    <li>
      <div><h3><a href="https://github.com/owner/repo/issues/408" data-testid="issue-listitem-title-link"><span><span>Wait for the list before reading it</span></span></a></h3></div>
      <div><span>owner/repo#408</span></div>
    </li>
    <li>
      <div><h3><a href="/owner/repo/issues/400" data-testid="issue-listitem-title-link"><span><span>A relative link still reads absolute</span></span></a></h3>
        <span><button type="button" aria-label="Filter by label docs"><span><span>docs</span></span></button></span>
      </div>
      <div><span>owner/repo#400</span></div>
    </li>
  </ul>
</div>`,
  "/missing/repo/issues": `${head("Page not found &middot; GitHub &middot; GitHub")}
<main><p>Find code, projects, and people on GitHub:</p><input type="text" aria-label="Search"></main>`,
};
