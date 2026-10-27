// Reads the post holding focus, or the one this page's address names, and
// null anywhere else. One function expression, run in the page, so it stands
// alone and reads only what the page already shows.
() => {
  const words = (node) =>
    node ? node.textContent.replace(/\s+/g, " ").trim() : "";
  const POST = 'article[data-testid="tweet"]';
  // One post, read the way the timeline tool reads it.
  const read = (article) => {
    let link = null;
    for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
      const at = new URL(anchor.getAttribute("href"), location.href);
      if (/\/status\/\d+/.test(at.pathname)) {
        link = at;
        break;
      }
    }
    if (!link) return null;
    const name = article.querySelector('[data-testid="User-Name"]');
    const handle = link.pathname.split("/").filter(Boolean)[0] || "";
    const stamp = article.querySelector("time");
    return {
      url: link.href,
      author: words(name && name.querySelector("a")),
      handle: handle ? "@" + handle : "",
      time: stamp ? stamp.getAttribute("datetime") : null,
      text: words(article.querySelector('[data-testid="tweetText"]')).slice(
        0,
        300,
      ),
    };
  };
  // Where the person is: the post holding focus first, then the one this
  // address is about.
  const active = document.activeElement;
  const focused = active && active.closest ? active.closest(POST) : null;
  if (focused) {
    const post = read(focused);
    if (post) return post;
  }
  const named = /\/status\/(\d+)/.exec(location.pathname);
  if (!named) return null;
  for (const article of document.querySelectorAll(POST)) {
    const post = read(article);
    if (post && new URL(post.url).pathname.endsWith("/status/" + named[1]))
      return post;
  }
  return null;
}
