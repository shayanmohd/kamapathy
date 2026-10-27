// The pages the google-search sample pack is measured against: a results
// page with a sponsored block, three organic results, a question card and
// the related searches, the two addresses Google sends a space to when it
// wants the person, and the search box with its suggestion list open and
// closed. Each one is hand written and carries only what the pack reads, in
// the structure the live pages had when the pack's selectors were settled.
const head = (title) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>`;

// The box and the list it owns, which the live page names through
// aria-controls: that name belongs to the wrapper, not to the listbox
// inside it, and the list stays in the page hidden once it is closed.
const box = (open) => `<form action="/search">
  <textarea name="q" role="combobox" aria-label="Search" aria-expanded="${open}"
    aria-controls="suggestion-hull" aria-owns="suggestion-hull">kamapa</textarea>
  <button aria-label="Google Search"></button>
</form>
<div id="suggestion-hull"${open === "true" ? "" : ' style="display:none"'}>
  <ul role="listbox" jsname="aajZCb">
    <li><div role="option" aria-label="kamapathy browser"
      ><span>kamapathy browser</span><span>Desktop browser</span></div></li>
    <li><div role="option" aria-label="kamapathy agent api"
      ><span>kamapathy agent api</span><span></span></div></li>
    <li><div role="option" aria-label="kamapalli"
      ><span>Kamapalli</span><span>Neighbourhood in Berhampur</span></div></li>
    <li><div role="option"><span>kamapathy docs</span></div></li>
  </ul>
</div>`;

// A snippet longer than the 300 characters a result keeps.
const long = `${"A long answer that says the same thing over and over again. ".repeat(6)}The end.`;

// A result the way a wall page would have to carry it for a tool that read
// the page instead of reading where it landed.
const trap = `<div id="search"><div id="rso"><div>
  <a href="https://wall.example.com/"><h3>A result nobody should read here</h3></a>
  <div data-sncf="1">A tool that reads a wall reports this as an answer.</div>
</div></div></div>`;

export const googlePages = {
  "/google/search": `${head("site:example.com a b - Google Search")}
<div id="tads">
  <div data-text-ad="1"><span>Sponsored</span>
    <a href="https://ads.example.com/buy"><h3>Example, on sale today</h3></a>
    <div data-sncf="1">Everything example, delivered by Thursday.</div>
  </div>
</div>
<div id="search">
  <div id="rso">
    <div data-hveid="CAEQAA">
      <a href="/url?q=https://docs.example.com/guide&amp;sa=U&amp;ved=2ahUKEwi"><h3>The example guide</h3><cite>docs.example.com</cite></a>
      <div data-sncf="1">How the guide explains itself, in one line.</div>
    </div>
    <div data-hveid="CAEQAB">
      <a href="/notes"><h3>Notes on example</h3><cite>example.org</cite></a>
    </div>
    <div data-initq="what is an example">
      <div role="heading">People also ask</div>
      <div><div role="heading">What is an example?</div>
        <a href="https://faq.example.com/what"><h3>An answer from the question card</h3></a>
      </div>
    </div>
    <div data-hveid="CAEQAC">
      <a href="https://long.example.com/"><h3>A long answer about example</h3></a>
      <div data-sncf="1">${long}</div>
    </div>
  </div>
  <div id="botstuff">
    <div><h3>Related searches</h3>
      <a href="https://related.example.com/"><h3>example packs</h3></a>
    </div>
  </div>
</div>`,
  // consent.google.com asks the person to choose before it shows anything,
  // whatever path it lands on, so the pack reads the host alone.
  "/google/consent": `${head("Before you continue to Google")}
<h1>Before you continue to Google Search</h1>
<button>Accept all</button>
${trap}`,
  // The verification page, at the path the live wall uses.
  "/google/sorry/index": `${head("https://www.google.com/search?q=example")}
<h1>About this page</h1>
<p>Our systems have detected unusual traffic from your computer network.</p>
${trap}`,
  // The box with its list open, as it stands while the person types, and the
  // same page once the list is closed again.
  "/google/suggest": `${head("Google")}
${box("true")}`,
  "/google/closed": `${head("Google")}
${box("false")}`,
};
