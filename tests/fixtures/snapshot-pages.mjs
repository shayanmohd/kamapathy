// Pages snapshots are measured against: three tall sections with a short
// frame and a tall card in the middle one, so a scrolled viewport holds the
// middle section, the top of the card and the top of the frame and nothing
// else; a frame from another origin and two lookalike controls beside them;
// a page of links of every protocol; a page of more text and controls than
// one part holds, whose ranked order differs from its page order, nested so
// its parts repeat ancestors; a page of every kind of node an outline
// prints; and a page of controls whose locators differ in kind, with
// lookalike controls and duplicate addresses that no locator can name.
// {{other}} becomes a second origin for the same server, which makes that
// frame cross origin.
const paragraph = (number) =>
  `<p>Paragraph ${number}: ${"the quick brown fox jumps over the lazy dog. ".repeat(3)}</p>`;
const buttons = (name, count) =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `<button id="${name.toLowerCase()}${index + 1}" type="button">${name} ${index + 1}</button>`,
  ).join("\n");
const options = (count) =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `<option value="s${index + 1}">Size ${index + 1}</option>`,
  ).join("");
// A 1 by 1 transparent GIF, so an image has a box without a request.
const pixel =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export const snapshotPages = {
  "/snapshot/sections": `<!doctype html><meta charset="utf-8"><title>Three sections</title>
<style>
body{font:14px sans-serif;margin:0}
p,h2{margin:0}
section{height:2000px}
iframe{display:block;border:0;width:300px;height:200px}
button{display:block;margin:0}
</style>
<section id="top">
<p>Top section text</p>
<button id="topButton" type="button">Top button</button>
<button class="twin" id="twinHidden" type="button" style="display:none">Twin</button>
<button class="twin" id="twin" type="button">Twin</button>
<iframe id="outer" title="Other origin" src="{{other}}/snapshot/frame"></iframe>
</section>
<section id="middle">
<p>Middle section text</p>
<button id="middleButton" type="button">Middle button</button>
<iframe id="inner" title="Inner notes" src="/snapshot/frame"></iframe>
<div id="card" draggable="true">
<p>Card top text</p>
<div style="height:1000px"></div>
<p>Card bottom text</p>
<button id="cardButton" type="button">Card button</button>
</div>
</section>
<section id="bottom">
<p>Bottom section text</p>
<button id="bottomButton" type="button">Bottom button</button>
</section>`,
  "/snapshot/frame": `<!doctype html><meta charset="utf-8"><title>Frame notes</title>
<style>body{font:14px sans-serif;margin:0}p{margin:0}button{display:block}</style>
<p>Frame near text</p>
<button id="frameButton" type="button">Frame button</button>
<div style="height:400px"></div>
<p>Frame far text</p>
<button id="frameFarButton" type="button">Frame far button</button>`,
  "/snapshot/parts": `<!doctype html><meta charset="utf-8"><title>More than one part</title>
<style>
body{font:14px sans-serif;margin:0}
p,pre{margin:0}
button{display:block}
#bar{position:fixed;left:0;right:0;bottom:0;background:#eee}
#bar button{display:inline-block}
#gap{width:900px;overflow:hidden}
</style>
<nav aria-label="Near"><ul>
${buttons("Near", 4)
  .split("\n")
  .map((button) => `<li>${button}</li>`)
  .join("\n")}
</ul></nav>
<main>
${[1, 2, 3, 4, 5, 6].map(paragraph).join("\n")}
<div id="gap"><pre>Gap start${" ".repeat(400)}Gap end</pre></div>
${[7, 8, 9, 10, 11, 12].map(paragraph).join("\n")}
<div style="height:1200px"></div>
${buttons("Far", 6)}
</main>
<div id="bar"><div role="toolbar" aria-label="Actions"><button id="save" type="button">Save draft</button><button id="submit" type="button">Submit</button></div></div>`,
  "/snapshot/outline": `<!doctype html><meta charset="utf-8"><title>Outline</title>
<style>
body{font:14px sans-serif;margin:0}
h2,p,ul,table,fieldset,legend{margin:0;padding:0}
canvas{display:block;width:40px;height:20px;background:#eee}
dialog{position:static;margin:0;border:0;padding:0}
#hollow,#hollow li{height:10px;list-style:none}
</style>
<header>
<a id="plans" href="/plans?tier=pro#faq">Plans</a>
<a id="away" href="http://other.example/pricing">Pricing elsewhere</a>
</header>
<nav aria-label="Sections">
<ul><li><a href="/one">One</a></li><li>Just text</li></ul>
</nav>
<ul id="hollow"><li><span></span></li></ul>
<main>
<h2>Plans</h2>
<p id="long">${"Long text about the plans. ".repeat(20)}</p>
<div><div><span></span></div></div>
<section aria-label="Pictures">
<img id="logo" src="${pixel}" alt="Company logo">
<img id="spacer" src="${pixel}" alt="">
<canvas id="chart"></canvas>
</section>
<section><p>Plain section text</p></section>
<table>
<caption>Prices</caption>
<tr><th>Plan</th><th>Price</th></tr>
<tr><td>Pro</td><td>9</td></tr>
</table>
<form id="order" aria-label="Order">
<fieldset><legend>Delivery</legend>
<label>Pickup <input type="radio" name="how" value="pickup" checked></label>
<label>Courier <input type="radio" name="how" value="courier"></label>
</fieldset>
<label for="pw">Password</label><input id="pw" type="password" value="hunter2">
<label for="tier">Tier</label>
<select id="tier"><option>Free</option><option value="pro" selected>Pro</option></select>
<label for="papers">Papers</label><input id="papers" type="file" multiple accept=".pdf">
<button type="submit">Save</button>
</form>
<label for="many">Size</label><select id="many">${options(25)}</select>
<form><input id="loose" type="text" aria-label="Loose field"></form>
<details><summary>More</summary><p>Hidden detail</p></details>
<div id="note" contenteditable="true">Editable note</div>
</main>
<aside>Aside text</aside>
<search><input id="find" type="search" aria-label="Find"></search>
<footer>Footer text</footer>
<dialog id="box" open aria-label="Confirm">
<p>Dialog text</p>
<button id="ok" type="button">OK</button>
</dialog>`,
  "/snapshot/locators": `<!doctype html><meta charset="utf-8"><title>Locators</title>
<style>body{font:14px sans-serif;margin:0}button,input,a{display:block}</style>
<button id="save" data-testid="save-button" type="button">Save</button>
<button id="checkout-form" type="button">Checkout</button>
<button type="button">Ship it</button>
<button id="item123" type="button">Archive</button>
<input id=":r12:" aria-label="Note" placeholder="First note">
<input aria-label="Note" placeholder="Second note">
<a href="/one" id="link1a2b3c4">Open</a>
<a href="/two" id="link2a2b3c4">Open</a>
<a href="/shared" id="rowa1b2c3d4">Shared</a>
<a href="/shared" id="rowe5f6g7h8">Shared</a>`,
  "/snapshot/links": `<!doctype html><meta charset="utf-8"><title>Every link</title>
<style>body{font:14px sans-serif;margin:16px}a{display:block}</style>
<a id="plain" href="http://example.com/catalog">Catalog</a>
<a id="secure" href="https://example.com/account?tab=plans#fees">Account</a>
<a id="mail" href="mailto:help@example.com?subject=Order">Mail us</a>
<a id="phone" href="tel:+15550100">Call us</a>
<a id="script" href="javascript:void 0">Run a script</a>
<a id="relative" href="/orders/4?from=list">Orders</a>
<a id="long" href="/long?q=${"a".repeat(2100)}">A long link</a>`,
};
