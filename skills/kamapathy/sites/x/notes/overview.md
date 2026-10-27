# X

A posting site, formerly at twitter.com. Almost nothing on it is readable
without an account: a signed out space is sent to the sign in flow, and some
spaces are refused outright. Every tool in this pack only reads.

Read `notes/timeline.md` before `timeline_posts`: it explains why a timeline
answers differently each time it is read.

## Addresses worth knowing

- A timeline: `https://x.com/home` for the account's own,
  `https://x.com/<handle>` for one account's posts.
- One post: `https://x.com/<handle>/status/<id>`, which is also the address
  every post links to. `https://x.com/i/web/status/<id>` reaches the same
  post without the handle.
- Accounts: `https://x.com/search?q=<words>&f=user`, with the words percent
  encoded. `f=live` gives the newest posts for the same words, `f=top` the
  ranked ones, and no `f` the ranked tab.
- `twitter.com` answers a permanent redirect to `x.com` for every path, so an
  old link lands on the same page. The pack matches both hosts because links
  still carry the old one.

## Where the person is needed

`timeline_posts` and `search_people` both stop with one sentence: "X needs
the person to sign in. Hand the space to the person, then run the tool
again." Hand the space over, let the person sign in, then call the tool again
in the same space.

- The sign in flow is `https://x.com/i/flow/login`, usually with a
  `redirect_after_login` query. Both tools read it from the address the page
  is on, `timeline_posts` at the start of every round, so a session that ends
  mid scroll stops there instead of answering with half a timeline.
- A space X refuses gets status 403 and an empty document: no markup at all,
  not even a sign in page. That is what this machine met from a signed out
  Chromium on every address above, so expect it. `search_people` reads the
  403 from its navigation and stops with the same sentence;
  `timeline_posts` navigates nowhere, so on such a page it answers no posts
  at all. When it answers nothing on a timeline the person can see, read the
  page with a snapshot before trusting the empty answer.
- Signing in, two factor prompts and device verification are always the
  person's to do. Nothing in this pack tries to sign in.

## How the pages are built

X draws every page after the document loads, and names what matters with
`data-testid` attributes rather than classes, whose names are generated. The
markers the tools read:

- `[data-testid="primaryColumn"]` is the main column, and
  `[data-testid="cellInnerDiv"]` wraps one row of whatever it lists.
  `search_people` waits for the column before reading.
- A post is `article[data-testid="tweet"]`. Inside it,
  `[data-testid="User-Name"]` holds the display name, the handle and the
  time on one line: the display name is that block's first link, and the
  time is a `time` element whose `datetime` attribute is the timestamp. The
  words of the post are `[data-testid="tweetText"]`, absent when a post
  carries only an image or a video.
- A post's own address is the link in that block whose path holds
  `/status/<digits>`. The tools read the handle from that path rather than
  from the text beside it, and keep each post once under that address.
- An account card is `[data-testid="UserCell"]`, with
  `[data-testid="UserDescription"]` for the bio. The card links to the
  profile twice, around the display name and around the handle, and links
  the avatar to a page of its own, so the tools read the first link whose
  path is one segment.
- A post's words and an account's bio are cut to 300 characters. Open the
  post itself when the whole text matters.

These markers were not read from a live page on the machine this pack was
written on, because X refused it; they are the names X's own pages have
carried for years, and the pack's test pages are built from them. When a
tool starts answering nothing on a page the person can see, take a snapshot,
read the page as it is now, and fix the selectors in the tool files.

## With page scripts off

Both tools read with page scripts, and `focused_post` is a page tool, so none
of them works without them. The addresses above still work, and these
locators hold across the site for a snapshot:

- `role=textbox[name="Search query"]` for the search box, with
  `role=tab[name="People"]` on the results page
- `role=link` rows in the main column, each holding a post or an account
- `role=button[name="Post"]` for the box that writes a post, which nothing
  here touches

## Writing

Nothing in this pack posts, replies, likes, reposts, bookmarks, follows,
blocks, messages or deletes. When the person asks for one of those, do it
yourself with their request behind it, and say what you did.
