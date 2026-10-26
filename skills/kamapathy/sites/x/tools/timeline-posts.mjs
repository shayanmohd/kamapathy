// The timeline already open, collected by scrolling it. This tool never
// navigates: open the timeline you want first, then call it. Read only, like
// every tool in this pack: nothing posts, replies, likes, reposts or follows.

// The shape of the loop: one read per round, a scroll and a wait between
// rounds, a stop three rounds after the timeline stops growing, and a stop
// at the thirtieth round whatever happens.
const ROUNDS = 30;
const QUIET = 3;
const PIXELS = 800;
const SETTLE = 700;

/**
 * The posts of the timeline this page is on, in the order it drew them.
 * @param {{ page: object }} context The agent page the tool works in.
 * @param {{ limit?: number }} args
 * @returns {Promise<{ url: string, author: string, handle: string, time: string | null, text: string }[]>}
 */
export async function timelinePosts({ page }, { limit = 20 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("limit must be an integer from 1 to 100.");
  const posts = new Map();
  let quiet = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round) {
      await page.scroll("down", PIXELS);
      // X draws what the scroll brought into view, so the next read waits.
      await page.waitForTimeout(SETTLE);
    }
    // Where the page stands, read before anything on it, so a session that
    // ends mid scroll hands the space over instead of half a timeline.
    if (walled(page.url)) throw wall();
    const read = await page.evaluate(readPosts);
    const before = posts.size;
    // A post is kept once, under its own address, however often the
    // timeline draws it again.
    for (const post of read)
      if (post.url && !posts.has(post.url) && posts.size < limit)
        posts.set(post.url, post);
    if (posts.size >= limit) break;
    quiet = posts.size > before ? 0 : quiet + 1;
    if (quiet >= QUIET) break;
  }
  return [...posts.values()];
}

// The address X sends a space to when it wants the person to sign in.
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

// Runs in the page, so it stands alone and reads only what the page shows:
// every post drawn into the timeline, in that order.
function readPosts() {
  const words = (node) =>
    node ? node.textContent.replace(/\s+/g, " ").trim() : "";
  const read = [];
  for (const article of document.querySelectorAll(
    'article[data-testid="tweet"]',
  )) {
    // The permalink: the post's own address, and the only name it can be
    // kept under.
    let link = null;
    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const at = new URL(anchor.getAttribute("href"), location.href);
      if (/\/status\/\d+/.test(at.pathname)) {
        link = at;
        break;
      }
    }
    if (!link) continue;
    const name = article.querySelector('[data-testid="User-Name"]');
    const handle = link.pathname.split("/").filter(Boolean)[0] || "";
    const stamp = article.querySelector("time");
    read.push({
      url: link.href,
      // The name block writes the display name, the handle and the time on
      // one line, and the display name is its first link.
      author: words(name && name.querySelector("a")),
      handle: handle ? `@${handle}` : "",
      time: stamp ? stamp.getAttribute("datetime") : null,
      text: words(article.querySelector('[data-testid="tweetText"]')).slice(
        0,
        300,
      ),
    });
  }
  return read;
}
