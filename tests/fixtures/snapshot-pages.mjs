// Pages snapshots are measured against: three tall sections with a short
// frame and a tall card in the middle one, so a scrolled viewport holds the
// middle section, the top of the card and the top of the frame and nothing
// else; a frame from another origin and two lookalike controls beside them;
// a page of links of every protocol; and a page of more text and controls
// than one part holds, whose ranked order differs from its page order.
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
${buttons("Near", 4)}
${[1, 2, 3, 4, 5, 6].map(paragraph).join("\n")}
<div id="gap"><pre>Gap start${" ".repeat(400)}Gap end</pre></div>
${[7, 8, 9, 10, 11, 12].map(paragraph).join("\n")}
<div style="height:1200px"></div>
${buttons("Far", 6)}
<div id="bar"><button id="save" type="button">Save draft</button><button id="submit" type="button">Submit</button></div>`,
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
