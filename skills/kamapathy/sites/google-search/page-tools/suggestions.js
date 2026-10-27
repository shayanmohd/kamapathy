// Reads the autocomplete list the search box has open, or [] when none is
// open. One function expression, run in the page, so it stands alone and
// reads only what the page already shows.
() => {
  const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
  // Open means shown: the page keeps its list in the document and hides it
  // again once the box is closed.
  const shown = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return node.getBoundingClientRect().height > 0;
  };
  // The box names the element its list sits in through aria-controls, which
  // is the wrapper around the listbox rather than the listbox itself.
  const box = document.querySelector('[role="combobox"]');
  const owned =
    box && (box.getAttribute("aria-controls") || box.getAttribute("aria-owns"));
  const hull = owned ? document.getElementById(owned) : null;
  const lists = [];
  if (hull)
    lists.push(
      hull.matches('[role="listbox"]')
        ? hull
        : hull.querySelector('[role="listbox"]'),
    );
  lists.push(...document.querySelectorAll('[role="listbox"]'));
  const list = lists.find(shown);
  if (!list) return [];
  const read = [];
  for (const option of list.querySelectorAll('[role="option"]')) {
    // The accessible name is the suggestion on its own, while the option's
    // text adds the description shown beside it.
    const label = (option.getAttribute("aria-label") || "").trim();
    const first = option.querySelector("span");
    const text = label || (first ? words(first) : words(option));
    if (text) read.push(text);
  }
  return read.slice(0, 20);
}
