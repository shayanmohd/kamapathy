# Google Search

A search engine. Reading results needs no account, but Google decides what a
space may read: it sends an unfamiliar one to a consent or a verification
page instead of results. Every tool in this pack only reads.

## Addresses worth knowing

- Results: `https://www.google.com/search?q=<words>&hl=en`, with the words
  percent encoded. `hl=en` asks for English, which keeps the page's wording
  the one these notes describe.
- The box alone: `https://www.google.com/`
- `tbm=isch` gives images, `tbm=nws` news, and `tbs=qdr:w` narrows to the
  last week. None of them is read by a tool here.

## Where the person is needed

Google answers two pages instead of results, and `search` stops at both with
one sentence: "Google is asking the person to choose or verify. Hand the
space to the person, then run the tool again."

- A consent page on `consent.google.com`, which asks the person to choose
  what Google may keep. Only the person can answer it.
- A verification page at `/sorry/index`, which asks the person to confirm
  they are not a robot. It arrives when the network or the space looks
  unusual, and it arrived on the machine this pack was written on, so expect
  it. Hand the space to the person, let them answer, then call the tool
  again in the same space.

Both are read from the address the navigation ends at, so a wall is never
reported as no results. A space signed in to a Google account from
country domains such as `consent.google.co.in` is outside this pack's
domains; a tool there fails waiting for the results area instead.

Signing in, two factor prompts and device verification are always the
person's to do. Nothing in this pack tries to sign in.

## How the pages are built

The results page renders after the document loads, so wait for the area
before reading it:

- `#search` holds the whole results area, and `#rso` inside it holds one
  block per result. `search` reads inside `#rso`, which leaves the ad slots
  and the related searches out by itself.
- A result's title is an `h3` inside its link, its address is that link's
  `href`, and its snippet is the `[data-sncf]` element in the same block.
  Snippets are cut to 300 characters.
- An address of the shape `/url?q=<target>` is Google's own redirect, and
  the target is what the result points at.
- Blocks that are not results: `#tads`, `#tadsb` and `#bottomads` for the
  sponsored ones, `[data-text-ad]` for an ad inside a slot, `[data-initq]`
  for a "People also ask" card, and `#botstuff` for the related searches.
  `search` skips every one of them. When Google renames one, the tool starts
  returning that block as a result, and the fix is this list in
  `tools/search.mjs`.
- The search box is `role=combobox[name="Search"]`, a `textarea` named `q`.
  Type into it with `page.fill` or the keyboard; it is not an input, so a
  value set any other way is ignored. Pressing Enter in it goes to the
  results page, which `search` reaches by address instead.
- The suggestions under the box sit in a `role=listbox` the box names through
  `aria-controls`, one `role=option` per suggestion, whose accessible name is
  the suggestion on its own while its text adds the description beside it.
  `suggestions` reads that list, and reads nothing while it is closed, so
  type into the box first and give the list a moment to arrive.

Google changes this page without notice, and a changed marker reads as no
results rather than as an error. When a result count looks wrong, take a
snapshot and read the page as it is now, then fix the selectors above.

## With page scripts off

`suggestions` needs page scripts, and so does the reading step of `search`.
Without them, open the address above and take a snapshot; these locators work
for the whole site:

- `role=combobox[name="Search"]` for the box, with
  `role=button[name="Google Search"]` beside it
- `role=link` rows in the results area, each holding the result title
- `role=navigation[name="Page navigation"]` at the foot of the results

## Writing

Nothing here signs in, opens a result, clicks an advertisement or submits a
form. When the person asks for one of those, do it yourself with their
request behind it, and say what you did.
