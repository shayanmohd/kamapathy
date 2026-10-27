// Reads the numbers a repository page shows, or null on any other page. One
// function expression, run in the page, so it stands alone and reads only
// what the page already shows.
() => {
  const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
  // A count as the page writes it, so "12.3k" reads 12300.
  const count = (text) => {
    const found = /^([\d.,]+)\s*([kmb])?$/i.exec(text);
    if (!found) return null;
    const base = Number(found[1].replace(/,/g, ""));
    if (!Number.isFinite(base)) return null;
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[(found[2] || "").toLowerCase()];
    return Math.round(base * (scale || 1));
  };
  // The sidebar writes each social count as its number and its word, so the
  // first text of that shape is the one to read.
  const counter = (word) => {
    const shape = new RegExp(`^([\\d.,]+[kmb]?) ${word}s?$`, "i");
    for (const node of document.querySelectorAll("a,span")) {
      const found = shape.exec(words(node));
      if (found) return count(found[1]);
    }
    return null;
  };
  const name = document.querySelector('a[data-testid="repo-name-link"]');
  if (!name) return null;
  const about = [...document.querySelectorAll("h2")].find(
    (heading) => words(heading) === "About",
  );
  const next = about && about.nextElementSibling;
  const paragraph = about
    ? next && next.tagName === "P"
      ? next
      : about.parentElement.querySelector("p")
    : null;
  const language = document.querySelector('a[href*="/search?l="]');
  const topics = [];
  for (const topic of document.querySelectorAll('a[href^="/topics/"]')) {
    const text = words(topic);
    if (text && !topics.includes(text)) topics.push(text);
  }
  return {
    fullName: new URL(name.getAttribute("href"), location.href).pathname.slice(
      1,
    ),
    description: paragraph ? words(paragraph).slice(0, 300) : null,
    stars: counter("star"),
    forks: counter("fork"),
    language: language ? words(language) : null,
    topics: topics.slice(0, 20),
  };
}
