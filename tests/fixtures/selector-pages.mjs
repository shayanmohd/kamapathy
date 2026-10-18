// Pages the selector engine is measured against: items before, inside and
// after an open shadow root with a closed root and a same-origin frame
// beside them, the text, href, XPath and filter forms with content a page
// hides from text matching, lookalike controls at every level, four rows of
// the same button, a control under a sticky header, a control behind a modal
// backdrop, and nodes a role resolution may pick.
export const selectorPages = {
  "/selectors/shadow": `<!doctype html><meta charset="utf-8"><title>Shadow items</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;border:1px solid #666;width:280px;height:70px}</style>
<button class="item" id="first" type="button">Item first</button>
<x-row class="card" id="host"><button class="item" id="light" type="button">Item light</button></x-row>
<x-sealed id="sealed"></x-sealed>
<iframe id="framed" title="Framed items" src="/selectors/frame-items"></iframe>
<button class="item" id="last" type="button">Item last</button>
<script>
class XRow extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button class="item" id="shadow" type="button">Item shadow</button><slot></slot>';
  }
}
customElements.define("x-row", XRow);
class XSealed extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<button class="item" id="sealedItem" type="button">Item sealed</button>';
    window.sealedItem = root.getElementById("sealedItem");
  }
}
customElements.define("x-sealed", XSealed);
</script>`,
  "/selectors/frame-items": `<!doctype html><meta charset="utf-8"><title>Framed items</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<button class="item" id="framedItem" type="button">Item framed</button>`,
  "/selectors/text": `<!doctype html><meta charset="utf-8"><title>Sign in now</title>
<style>body{font:14px sans-serif;margin:16px}/* sign in style */</style>
<script>var scriptNote = "sign in script";</script>
<button id="signin" type="button"><b>Sign&shy;</b>   <i>in</i></button>
<button id="exact" type="button">Log in<span>!</span></button>
<button id="longer" type="button">Log in now</button>
<input id="order" type="submit" value="Place order">
<a id="plans" href="/plans?tier=pro#faq">Plans</a>
<ul id="invoices">
<li id="row-a"><span>Invoice 12</span> paid</li>
<li id="row-b"><x-amount id="amount"></x-amount></li>
</ul>
<x-list id="shadowList"></x-list>
<button id="save" type="button">Save</button>
<button id="saveAll" type="button">Save all</button>
<p id="note">Fine print</p>
<iframe id="listFrame" title="Framed list" src="/selectors/frame-list"></iframe>
<script>
class XAmount extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" }).innerHTML = '<em>Invoice 12 due</em>';
  }
}
customElements.define("x-amount", XAmount);
class XList extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" }).innerHTML = '<ul><li>Shadow first</li><li>Shadow second</li></ul>';
  }
}
customElements.define("x-list", XList);
</script>`,
  "/selectors/frame-list": `<!doctype html><meta charset="utf-8"><title>Framed list</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<ul id="frameList"><li>Frame first</li><li>Frame second</li></ul>`,
  "/selectors/nth": `<!doctype html><meta charset="utf-8"><title>Three picks</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<button class="pick" id="zero" type="button">Zero</button>
<button class="pick" id="one" type="button" style="display:none">One</button>
<button class="pick" id="two" type="button">Two</button>`,
  "/selectors/levels": `<!doctype html><meta charset="utf-8"><title>Lookalike fields</title>
<style>body{font:14px sans-serif;margin:16px}input{display:block;margin:6px 0}iframe{display:block;border:1px solid #666;width:320px;height:180px}</style>
<input class="save" id="saveHidden" aria-label="Save hidden" style="display:none">
<input class="save" id="saveDisabled" aria-label="Save disabled" disabled>
<input class="save" id="saveReady" aria-label="Save ready">
<input class="gone" id="gone" aria-label="Gone" style="display:none">
<input class="only" id="onlyTop" aria-label="Only top">
<iframe id="inner" title="Framed fields" src="/selectors/frame-levels"></iframe>`,
  "/selectors/frame-levels": `<!doctype html><meta charset="utf-8"><title>Framed fields</title>
<style>body{font:14px sans-serif;margin:8px}input{display:block;margin:4px 0}</style>
<input class="only" id="onlyOne" aria-label="Frame one">
<input class="only" id="onlyTwo" aria-label="Frame two">
<input class="deep" id="deepOne" aria-label="Deep one">
<input class="deep" id="deepTwo" aria-label="Deep two">
<input class="lone" id="lone" aria-label="Lone frame">`,
  "/selectors/many": `<!doctype html><meta charset="utf-8"><title>Invoice rows</title>
<style>body{font:14px sans-serif;margin:16px}li{margin:4px 0}</style>
<ul id="rows">
<li id="row1"><span>Invoice 11</span> <button class="row-remove" type="button">Remove</button></li>
<li id="row2"><span>Invoice 12</span> <button class="row-remove" type="button">Remove</button></li>
<li id="row3"><span>Invoice 13</span> <button class="row-remove" type="button">Remove</button></li>
<li id="row4"><span>Invoice 14</span> <button class="row-remove" type="button">Remove</button></li>
</ul>`,
  "/selectors/covered": `<!doctype html><meta charset="utf-8"><title>Sticky header</title>
<style>body{font:14px sans-serif;margin:0}#bar{position:fixed;top:0;left:0;right:0;height:60px;background:#dde;z-index:10}</style>
<div id="bar">Header</div>
<div style="height:400px"></div>
<button id="under" type="button" style="margin-left:40px">Under header</button>
<div style="height:1400px"></div>`,
  "/selectors/modal": `<!doctype html><meta charset="utf-8"><title>Modal choice</title>
<style>body{font:14px sans-serif;margin:16px}#backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:20}#modal{position:fixed;top:140px;left:140px;z-index:30;background:#fff;padding:12px}</style>
<p id="status" role="status">nothing</p>
<button class="act" id="pageAct" type="button">Confirm</button>
<div id="backdrop"></div>
<div id="modal"><button class="act" id="modalAct" type="button">Confirm</button></div>
<script>
document.addEventListener("click", (event) => {
  const id = event.target instanceof Element ? event.target.id : "";
  if (id) document.getElementById("status").textContent = "clicked " + id;
}, true);
</script>`,
  "/selectors/picked": `<!doctype html><meta charset="utf-8"><title>Picked nodes</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;border:1px solid #666;width:280px;height:70px}#editor{border:1px solid #999;padding:4px;width:200px}</style>
<button id="topSave" type="button">Save</button>
<x-pick id="pickHost"></x-pick>
<x-locked id="lockedHost"></x-locked>
<div id="editor" contenteditable="true">Editable note</div>
<div id="plain">Plain note</div>
<iframe id="saveFrame" title="Framed save" src="/selectors/frame-save"></iframe>
<script>
class XPick extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="shadowSave" type="button">Save</button>';
    window.shadowSave = root.getElementById("shadowSave");
  }
}
customElements.define("x-pick", XPick);
class XLocked extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<button id="lockedSave" type="button">Save</button>';
    window.lockedSave = root.getElementById("lockedSave");
  }
}
customElements.define("x-locked", XLocked);
</script>`,
  "/selectors/frame-save": `<!doctype html><meta charset="utf-8"><title>Framed save</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<button id="frameSave" type="button">Save</button>`,
};
