# Reading an X timeline

A timeline is not a list the page holds. X draws only the posts near the
viewport and drops the ones that scroll away, so what the document holds at
any moment is a window onto a stream, not the stream itself. Everything
below follows from that.

## What `timeline_posts` does about it

- It never navigates. Open the timeline you want first, with
  `page.goto("https://x.com/home")` or an account's own address, then call
  the tool. It reads the page it is given.
- One round is one read of the page. Between rounds it scrolls down 800
  pixels and waits 700 ms, which is about what X needs to draw the next
  screen.
- A post is kept once, under its own address, so a post the page draws again
  after a scroll is not collected twice.
- It stops at the limit, three rounds after the collection stops growing, or
  at the thirtieth round, whichever comes first, and answers with what it
  has. There is no way to ask for the whole timeline: it has no end.

## What that means for an answer

- The answer is a sample, not the timeline. A post can sit between two
  screens and be missed, and the same call twice can answer differently.
- The order of posts can change between rounds. X reorders a home timeline
  as it goes, so two reads can hold the same posts in another order, and a
  post that was near the top can arrive again further down. The tool keeps
  the order it first saw each post in.
- A count read twice can differ: likes, reposts and replies move while the
  page is open, and an account's own timeline shows reposts that may vanish.
  Never report a count as a fact; say when it was read.
- Asking for more than the page can draw costs scrolls and answers nothing
  new, which is why the three quiet rounds end the loop early. A limit of 20
  or so is where the tool is quickest; 100 takes the full thirty rounds on a
  busy timeline.
- A timeline the person is not signed in to answers nothing. Read
  `notes/overview.md` for the sign in flow and the bare refusal X answers
  some spaces.

## When you need one post rather than a timeline

Open its own address and read it with `focused_post`, which answers the post
holding focus, or the one the address names. That reading is stable, because
a post page is about one post.
