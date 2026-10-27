# GitHub

Code hosting. Reading is open to anyone; anything that changes a repository,
and every private repository, needs the space to be signed in as the person.
Every tool in this pack only reads.

## Addresses worth knowing

- Repository: `https://github.com/<owner>/<repo>`
- Open issues: `https://github.com/<owner>/<repo>/issues?q=is%3Aissue%20state%3Aopen`
- Repository search: `https://github.com/search?q=<words>&type=repositories`,
  with the words percent encoded. `type=` also takes `issues`, `code`,
  `users` and `commits`.
- An account or organization: `https://github.com/<owner>`

Owner names are letters, digits and inner hyphens, up to 39 characters.
Repository names add dots and underscores, up to 100.

## Where the person is needed

- A repository that does not exist and a private one both answer the same
  "Page not found" page, with status 404. `open_issues` throws one sentence
  for both, because from outside they cannot be told apart: ask the person to
  sign the space in, or check the name with them.
- Signing in, two factor prompts and device verification are always the
  person's to do. Nothing in this pack tries to sign in.
- Code search needs a signed in account; repository search does not.

## How the pages are built

The repository, search and issues pages render their lists after the document
loads, so wait for the container before reading:

- Search results sit in `[data-testid="results-list"]`, one child element per
  result. A result's title is a link inside `.search-title`, its snippet is
  the row's own text, its language is a span whose accessible name ends in
  "language", and its star count is the link ending in `/stargazers`.
- The issues list sits in `[data-testid="issues-list-surface"]`, one list item
  per issue. The title link carries `data-testid="issue-listitem-title-link"`
  and its address ends in the issue number. Labels are the buttons whose
  accessible name starts with "Filter by label". Pinned issues sit above the
  list and carry no such title link, so they are left out.
- A repository page has the name link `a[data-testid="repo-name-link"]`, an
  About section whose heading says About with the description right after it,
  topic links starting `/topics/`, a language link holding `/search?l=`, and
  the star and fork counts as text such as "12.3k stars" and "481 forks".

Counts are written the way they are shown, so "12.3k" means 12300. Times come
from the `datetime` attribute of a `relative-time` element, not from its text.

## With page scripts off

`repository_stats` needs page scripts, and so does the reading step of both
Node tools. Without them, open the address above and take a snapshot; these
locators work for the whole site:

- `role=link[name="Issues"]`, `role=link[name="Pull requests"]` and the other
  repository tabs
- `role=searchbox[name="Search or jump to..."]` in the header
- `role=button[name="Star this repository"]`, which only a signed in space
  sees, and which nothing here presses
- On a search page, `role=link` rows inside the results list above

## Writing

Nothing here stars, follows, forks, comments, opens an issue or submits a
form. When the person asks for one of those, do it yourself with their
request behind it, and say what you did.
