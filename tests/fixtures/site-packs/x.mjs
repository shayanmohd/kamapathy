// The pages the x sample pack is measured against: a timeline that draws
// more posts as it is scrolled, one that never runs out, a people search
// that keeps answering, the sign in flow, and a post page with its replies.
// Each one is hand written and carries only what the pack reads, in the
// structure x.com renders through its own markers.
const head = (title) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; font: 15px system-ui; }
  [data-testid="cellInnerDiv"] { min-height: 220px; border-bottom: 1px solid #eee; }
</style>`;

// One post, as a timeline renders it: the name block holds the display name,
// the handle and the permalink with its time, and the words sit in a marker
// of their own. A post with no words at all leaves that marker out.
function post({ id, name, handle, time, text, href }) {
  const link = href || `/${handle}/status/${id}`;
  const stamp = time
    ? `<time datetime="${time}">Oct 20</time>`
    : "<span>Oct 20</span>";
  return `<div data-testid="cellInnerDiv"><article data-testid="tweet" tabindex="-1">
  <div data-testid="User-Name">
    <div><a role="link" href="/${handle}"><span>${name}</span></a></div>
    <div><a role="link" href="/${handle}"><span>@${handle}</span></a></div>
    <div><span>&middot;</span><a role="link" href="${link}">${stamp}</a></div>
  </div>
  ${text === null ? "" : `<div data-testid="tweetText" lang="en">${text}</div>`}
</article></div>`;
}

// One account in a people search. The live cell links to the profile twice,
// once around the display name and once around the handle, and links the
// avatar to a page of its own; a cell that holds both names in one link is
// here too, because the reading has to carry either shape.
function account({ handle, name, bio, oneLink }) {
  const names = oneLink
    ? `<a role="link" href="/${handle}"><span>${name}</span><span>@${handle}</span></a>`
    : `<a role="link" href="/${handle}"><span>${name}</span></a>
    <a role="link" href="/${handle}"><span>@${handle}</span></a>`;
  return `<div data-testid="cellInnerDiv"><div data-testid="UserCell">
  <a role="link" href="/${handle}/photo"><img alt="" src="data:," width="40" height="40"></a>
  <div>${names}</div>
  ${bio === null ? "" : `<div data-testid="UserDescription">${bio}</div>`}
  <button type="button" data-testid="1234-follow">Follow</button>
</div></div>`;
}

// Longer than the 300 characters a post's words and an account's bio keep.
const long = `${"A line that says the same thing again and again. ".repeat(8)}The end.`;

// The lazy loading every x page does: a batch of cells arrives each time the
// list is scrolled, and nothing arrives once the batches run out. The draw
// hangs off window.scrollBy, the call a scroll is made with, so one scroll
// draws one screen however many scroll events the browser fires for it.
const lazy = (batches) => `<script>
  const batches = ${JSON.stringify(batches)};
  const list = document.getElementById("timeline");
  let next = 0;
  const scrollBy = window.scrollBy.bind(window);
  window.scrollBy = (x, y) => {
    scrollBy(x, y);
    if (next >= batches.length) return;
    list.insertAdjacentHTML("beforeend", batches[next]);
    next += 1;
  };
</script>`;

// The same loading with no end to it: each scroll draws one more cell, built
// from a template whose id is replaced.
const endless = (template, first) => `<script>
  const template = ${JSON.stringify(template)};
  const list = document.getElementById("timeline");
  let id = ${first};
  const scrollBy = window.scrollBy.bind(window);
  window.scrollBy = (x, y) => {
    scrollBy(x, y);
    id += 1;
    list.insertAdjacentHTML(
      "beforeend",
      template.split("__ID__").join(String(id)),
    );
  };
</script>`;

const homePosts = [
  post({
    id: 1001,
    name: "Kamapathy",
    handle: "kamapathy",
    time: "2026-10-20T09:30:00.000Z",
    text: "A calm desktop browser you share with your agents.",
  }),
  post({
    id: 1002,
    name: "Agent News",
    handle: "agentnews",
    time: "2026-10-20T08:15:00.000Z",
    text: long,
  }),
  // An image only post: the words marker is absent.
  post({
    id: 1003,
    name: "Pixel Press",
    handle: "pixelpress",
    time: "2026-10-20T07:00:00.000Z",
    text: null,
  }),
  // A permalink with no time in it at all.
  post({
    id: 1004,
    name: "Desk Smith",
    handle: "desksmith",
    time: null,
    text: "A post with no timestamp in its link.",
  }),
];

// What each scroll brings: two new posts and a repeat, then one new post
// whose permalink is already absolute and another repeat, then the last two.
const homeBatches = [
  post({
    id: 1005,
    name: "Owl Post",
    handle: "owlpost",
    time: "2026-10-20T06:30:00.000Z",
    text: "The second screen arrives on the first scroll.",
  }) +
    post({
      id: 1006,
      name: "Two Keys",
      handle: "twokeys",
      time: "2026-10-20T06:00:00.000Z",
      text: "Another post from the second screen.",
    }) +
    homePosts[0],
  post({
    id: 1007,
    name: "Slow Loop",
    handle: "slowloop",
    href: "https://x.com/slowloop/status/1007",
    time: "2026-10-20T05:00:00.000Z",
    text: "A post whose permalink is already absolute.",
  }) + homePosts[2],
  post({
    id: 1008,
    name: "Desk Plant",
    handle: "deskplant",
    time: "2026-10-20T04:00:00.000Z",
    text: "The third screen arrives on the third scroll.",
  }) +
    post({
      id: 1009,
      name: "Lamp Light",
      handle: "lamplight",
      time: "2026-10-20T03:30:00.000Z",
      text: "The last post this timeline holds.",
    }),
];

const searchAccounts = [
  account({
    handle: "kamapathy",
    name: "Kamapathy",
    bio: "A calm desktop browser you share with your agents.",
  }),
  // No bio at all.
  account({ handle: "agentnews", name: "Agent News", bio: null }),
  // Both names in one link, and a bio longer than an account keeps.
  account({
    handle: "onelink",
    name: "One Link",
    bio: long,
    oneLink: true,
  }),
];

// The posts and the account a wall page carries, so a tool that read the
// page instead of reading where it landed would answer with these.
const trap = `<div data-testid="primaryColumn" id="timeline">
${post({
  id: 9001,
  name: "Wall Post",
  handle: "wallpost",
  time: "2026-10-20T02:00:00.000Z",
  text: "A tool that reads a wall reports this as a post.",
})}
${account({ handle: "wallperson", name: "Wall Person", bio: "Nobody should read this here." })}
</div>`;

const statusId = "1900000000000000001";

export const xPages = {
  // The home timeline, which draws three more screens as it is scrolled.
  "/x/home": `${head("Home / X")}
<main role="main"><div data-testid="primaryColumn">
  <div aria-label="Timeline: Your Home Timeline" id="timeline">
${homePosts.join("\n")}
  </div>
</div></main>
${lazy(homeBatches)}`,
  // A timeline with no end, which is how the scroll cap is measured.
  "/x/endless": `${head("Home / X")}
<main role="main"><div data-testid="primaryColumn">
  <div aria-label="Timeline: Your Home Timeline" id="timeline">
${post({
  id: 2001,
  name: "Loop",
  handle: "loop",
  time: "2026-10-20T09:00:00.000Z",
  text: "Post 2001.",
})}
  </div>
</div></main>
${endless(
  post({
    id: "__ID__",
    name: "Loop",
    handle: "loop",
    time: "2026-10-20T09:00:00.000Z",
    text: "Post __ID__.",
  }),
  2001,
)}`,
  // The people tab of search, which also keeps answering as it is scrolled.
  "/x/search": `${head("a b - Search / X")}
<main role="main"><div data-testid="primaryColumn" id="timeline">
${searchAccounts.join("\n")}
</div></main>
${endless(
  account({
    handle: "person__ID__",
    name: "Person __ID__",
    bio: "Account __ID__.",
  }),
  0,
)}`,
  // The sign in flow, at the path the live wall uses.
  "/x/i/flow/login": `${head("X. It's what's happening / X")}
<main role="main"><h1>Sign in to X</h1>
<button type="button">Sign in with Google</button>
${trap}
</main>`,
  // One post with its replies, where the second one takes focus.
  [`/x/kamapathy/status/${statusId}`]: `${head("Kamapathy on X")}
<main role="main"><div data-testid="primaryColumn" id="timeline">
${post({
  id: statusId,
  name: "Kamapathy",
  handle: "kamapathy",
  time: "2026-10-20T09:30:00.000Z",
  text: "A calm desktop browser you share with your agents.",
})}
${post({
  id: "1900000000000000002",
  name: "Owl Post",
  handle: "owlpost",
  time: "2026-10-20T10:00:00.000Z",
  text: "The reply that holds focus.",
})}
${post({
  id: "1900000000000000003",
  name: "Two Keys",
  handle: "twokeys",
  time: "2026-10-20T10:05:00.000Z",
  text: "A second reply, which holds nothing.",
})}
</div></main>
<script>
  document.querySelectorAll('article[data-testid="tweet"]')[1].focus();
</script>`,
};
