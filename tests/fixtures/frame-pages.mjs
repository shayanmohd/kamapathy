// Pages whose controls sit inside open shadow roots and same-origin frames,
// as component libraries and embedded forms draw them, plus a frame from
// another origin that a snapshot can only announce. That frame is served by
// the same server through the other loopback name. The frames carry a border
// and padding, and the deep button sits at the frame's top left corner, so a
// click that ignores the frame offsets lands outside it. The later pages host
// a frame inside a shadow root, scroll and scale frames, give a frame control
// the same selector as one outside it, and hide frames with CSS visibility.
// Section 9's pages put a payment form from the other name beside a 1 by 1
// tracking frame, on a page that takes focus, under an overlay, far below the
// fold, added after a wait and loading another document on demand. The
// checkout page holds a frame from the other name beside one of this host on
// another port, and the later pages hold twelve frames from another site and
// a frame that blocks its own thread. {{other}} is this server under its
// other loopback name, {{otherPort}} this name on its second port.
export const framePages = {
  "/frames/shadow": `<!doctype html><meta charset="utf-8"><title>Shadow controls</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Shadow settings</h1>
<x-card id="card"><span slot="title">Notifications</span><button slot="action" type="button" id="light">Slotted action</button><span>Not shown</span></x-card>
<p id="shadow-result" role="status">Shadow untouched</p>
<script>
class XCard extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div style="border:1px solid #666;padding:12px"><h2><slot name="title"></slot></h2><p>Rendered in the shadow root</p><label for="alerts">Email alerts</label><input id="alerts" type="checkbox"><button type="button" id="save">Save preferences</button><slot name="action"></slot></div>';
    root.getElementById("save").onclick = () => { document.getElementById("shadow-result").textContent = "Saved from shadow"; };
  }
}
customElements.define("x-card", XCard);
document.getElementById("light").onclick = () => { document.getElementById("shadow-result").textContent = "Slotted clicked"; };
</script>`,
  "/frames/outer": `<!doctype html><meta charset="utf-8"><title>Embedded forms</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;border:4px solid #666;padding:6px;width:420px;height:300px}#other{height:80px}</style>
<h1>Outer page</h1>
<p>Text above the frame</p>
<iframe id="inner" title="Inner form" src="/frames/inner"></iframe>
<p id="outer-result" role="status">Outer untouched</p>
<iframe id="other" title="Card details"></iframe>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
document.getElementById("other").src = location.origin.replace(location.hostname, otherHost) + "/frames/other";
</script>`,
  "/frames/inner": `<!doctype html><meta charset="utf-8"><title>Inner form</title>
<style>body{font:14px sans-serif;margin:8px}iframe{display:block;border:2px solid #999;padding:4px;width:300px;height:60px}</style>
<p>Text inside the frame</p>
<label for="note">Frame note</label><input id="note" type="text">
<button type="button" id="apply">Apply in frame</button>
<input id="file" type="file" aria-label="Frame file">
<p id="inner-result" role="status">Inner untouched</p>
<iframe id="nested" title="Nested frame" src="/frames/nested"></iframe>
<script>
const result = document.getElementById("inner-result");
document.getElementById("apply").onclick = () => { result.textContent = "Applied " + document.getElementById("note").value; };
document.getElementById("note").onkeydown = (event) => { if (event.key === "Enter") result.textContent = "Entered " + event.target.value; };
document.getElementById("file").onchange = (event) => { result.textContent = "Files " + event.target.files.length; };
</script>`,
  "/frames/nested": `<!doctype html><meta charset="utf-8"><title>Nested frame</title>
<style>body{font:14px sans-serif;margin:0}#deep{position:absolute;left:0;top:0;width:90px;height:20px;padding:0}</style>
<button type="button" id="deep" onclick="this.textContent='Deep clicked'">Deep button</button>
<p style="margin:28px 0 0">Text two frames deep</p>`,
  "/frames/other": `<!doctype html><meta charset="utf-8"><title>Card details</title><p>Card number</p><input aria-label="Card number">`,
  "/frames/checkout": `<!doctype html><meta charset="utf-8"><title>Payment</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<p>Pay with a card</p>
<label for="card">Card number</label><input id="card" name="cardnumber" autocomplete="cc-number">
<button type="button" id="pay" style="margin-top:120px" onclick="this.textContent='Paid'">Pay now</button>
<p id="checkout-result" role="status">Checkout untouched</p>
<script>
const result = document.getElementById("checkout-result");
document.getElementById("card").onkeydown = (event) => { if (event.key === "Enter") result.textContent = "Entered " + event.target.value.length + " digits"; };
</script>`,
  "/frames/tracker": `<!doctype html><meta charset="utf-8"><title>Tracking frames</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;border:0;padding:0}#shown{width:300px;height:100px}#pixel{width:1px;height:1px}</style>
<p>Text beside the frames</p>
<iframe id="shown" title="Card details"></iframe>
<iframe id="pixel" title="Tracker"></iframe>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
const otherOrigin = location.origin.replace(location.hostname, otherHost);
document.getElementById("shown").src = otherOrigin + "/frames/other";
document.getElementById("pixel").src = otherOrigin + "/frames/other?pixel=1";
</script>`,
  "/frames/focus": `<!doctype html><meta charset="utf-8"><title>Focus frames</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:360px;height:160px;border:2px solid #666;padding:4px;margin:0 0 8px}</style>
<h1>Focus page</h1>
<input id="top-field" aria-label="Top field">
<iframe id="same" title="Same origin form" src="/frames/embedded"></iframe>
<iframe id="cross" title="Payment form"></iframe>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
document.getElementById("cross").src = location.origin.replace(location.hostname, otherHost) + "/frames/checkout";
</script>`,
  "/frames/covered": `<!doctype html><meta charset="utf-8"><title>Covered frame</title>
<style>body{font:14px sans-serif;margin:0}#pay{display:block;position:absolute;left:0;top:60px;width:400px;height:300px;border:0}#veil{position:absolute;left:0;top:0;width:900px;height:120px;background:rgba(0,0,0,0.2)}button{position:absolute;left:0;top:10px;margin:0}</style>
<button type="button" id="duplicate" onclick="this.textContent='Top paid'">Pay now</button>
<iframe id="pay" title="Payment form"></iframe>
<div id="veil"></div>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
document.getElementById("pay").src = location.origin.replace(location.hostname, otherHost) + "/frames/checkout";
</script>`,
  "/frames/far": `<!doctype html><meta charset="utf-8"><title>Far frame</title>
<style>body{font:14px sans-serif;margin:0}#spacer{height:1600px}iframe{display:block;width:400px;height:200px;border:0}</style>
<p>Top of the far page</p>
<div id="spacer"></div>
<iframe id="far" title="Payment form"></iframe>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
document.getElementById("far").src = location.origin.replace(location.hostname, otherHost) + "/frames/checkout";
</script>`,
  "/frames/late": `<!doctype html><meta charset="utf-8"><title>Late frame</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:400px;height:200px;border:0}</style>
<p>Waiting for the form</p>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
setTimeout(() => {
  const frame = document.createElement("iframe");
  frame.id = "late";
  frame.title = "Payment form";
  frame.src = location.origin.replace(location.hostname, otherHost) + "/frames/checkout";
  document.body.append(frame);
}, 1500);
</script>`,
  "/frames/navigating": `<!doctype html><meta charset="utf-8"><title>Navigating frame</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:400px;height:200px;border:0}</style>
<button type="button" id="again" onclick="document.getElementById('moving').src = next()">Load the next page</button>
<iframe id="moving" title="Payment form"></iframe>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
const otherOrigin = location.origin.replace(location.hostname, otherHost);
let loaded = 0;
const next = () => (loaded++ % 2 ? otherOrigin + "/frames/checkout" : otherOrigin + "/frames/other");
document.getElementById("moving").src = next();
</script>`,
  "/frames/pay": `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:420px;height:220px;border:4px solid #666;padding:6px;margin:0 0 10px}</style>
<h1>Checkout</h1>
<p>Text above the frames</p>
<iframe id="card" title="Card details" src="{{other}}/frames/checkout"></iframe>
<p>Text between the frames</p>
<iframe id="billing" title="Billing details" src="{{otherPort}}/frames/billing"></iframe>
<p id="pay-result" role="status">Nothing paid</p>`,
  "/frames/billing": `<!doctype html><meta charset="utf-8"><title>Billing</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<p>Billing address</p>
<label for="postcode">Postcode</label><input id="postcode" name="postcode">
<button type="button" id="save-billing" onclick="this.textContent='Billing saved'">Save billing</button>`,
  "/frames/many": `<!doctype html><meta charset="utf-8"><title>Many frames</title>
<style>body{font:14px sans-serif;margin:0}iframe{display:block;width:200px;height:60px;border:0}</style>
<p>Twelve frames from another site</p>
<script>
for (let index = 0; index < 9; index += 1) {
  const frame = document.createElement("iframe");
  frame.title = index === 8 ? "Three widgets" : "Widget " + (index + 1);
  frame.src = "{{other}}" + (index === 8 ? "/frames/triple" : "/frames/widget?n=" + (index + 1));
  document.body.append(frame);
}
</script>`,
  // The frames inside this one come from its own name on the other port, so
  // each is a frame from another origin that Chromium keeps in this page's
  // process. A grandchild from the top page's own site would lose its
  // session instead, which no read can reach.
  "/frames/triple": `<!doctype html><meta charset="utf-8"><title>Three widgets</title>
<style>body{font:14px sans-serif;margin:0}iframe{display:block;width:180px;height:40px;border:0}</style>
<p>Three widgets inside</p>
<script>
for (let index = 0; index < 3; index += 1) {
  const frame = document.createElement("iframe");
  frame.title = "Inner widget " + (index + 1);
  frame.src = "{{otherPort}}/frames/widget?inner=" + (index + 1);
  document.body.append(frame);
}
</script>`,
  "/frames/widget": `<!doctype html><meta charset="utf-8"><title>Widget</title>
<style>body{font:14px sans-serif;margin:0}</style>
<p>Widget text</p><button type="button">Widget action</button>`,
  // One frame from another site blocks its own thread shortly after it has
  // loaded, so a read of it never answers; the frame beside it, of this
  // page's own site on another port, answers as usual.
  "/frames/stuck": `<!doctype html><meta charset="utf-8"><title>Busy frames</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:300px;height:80px;border:0}</style>
<p>One frame is busy</p>
<iframe id="busy" title="Busy widget" src="{{other}}/frames/busy"></iframe>
<iframe id="calm" title="Calm widget" src="{{otherPort}}/frames/widget?calm=1"></iframe>`,
  "/frames/busy": `<!doctype html><meta charset="utf-8"><title>Busy widget</title>
<style>body{font:14px sans-serif;margin:0}</style>
<p>Busy text</p>
<script>setTimeout(() => { const end = Date.now() + 20000; while (Date.now() < end); }, 300);</script>`,
  "/frames/shadow-frame": `<!doctype html><meta charset="utf-8"><title>Shadow frame</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Widget host</h1>
<x-widget id="widget"></x-widget>
<script>
class XWidget extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<iframe id="embedded" title="Embedded form" src="/frames/embedded" style="display:block;width:360px;height:160px;border:3px solid #666;padding:5px"></iframe>';
  }
}
customElements.define("x-widget", XWidget);
</script>`,
  "/frames/embedded": `<!doctype html><meta charset="utf-8"><title>Embedded form</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<button type="button" id="count" onclick="this.textContent='Counted '+(++window.clicks)">Count clicks</button>
<label for="word">Embedded word</label><input id="word" type="text">
<p id="embedded-result" role="status">Embedded untouched</p>
<script>
window.clicks = 0;
document.getElementById("word").onkeydown = (event) => { if (event.key === "Enter") document.getElementById("embedded-result").textContent = "Entered " + event.target.value; };
</script>`,
  "/frames/scroller": `<!doctype html><meta charset="utf-8"><title>Frame scroller</title>
<style>body{margin:0}iframe{display:block;width:400px;height:200px;border:0}</style>
<iframe id="tall" title="Tall list" src="/frames/tall"></iframe>`,
  "/frames/tall": `<!doctype html><meta charset="utf-8"><title>Tall list</title>
<style>body{margin:0}</style>
<button type="button" id="first">First item</button>
<div style="height:3000px"></div>
<button type="button" id="last">Last item</button>`,
  // A frame from another site with a veil over its top part, and a grid
  // inside it at known positions: a point under the veil is covered by the
  // page around the frame, and the one below it is reached as usual.
  "/frames/sealed": `<!doctype html><meta charset="utf-8"><title>Sealed frame</title>
<style>body{margin:0}#grid{display:block;position:absolute;left:0;top:40px;width:400px;height:220px;border:0}#seal{position:absolute;left:0;top:0;width:900px;height:140px;background:rgba(0,0,0,0.2)}</style>
<iframe id="grid" title="Sealed grid"></iframe>
<div id="seal"></div>
<script>
const otherHost = location.hostname === "localhost" ? "127.0.0.1" : "localhost";
document.getElementById("grid").src = location.origin.replace(location.hostname, otherHost) + "/frames/inner-grid";
</script>`,
  // A frame from another site drawn at half size, holding a frame of this
  // page's own name on another port: a press inside the innermost document
  // crosses two boundaries and one scale.
  "/frames/half": `<!doctype html><meta charset="utf-8"><title>Half size frames</title>
<style>body{margin:0}#half{display:block;width:400px;height:300px;border:4px solid #666;padding:6px;transform:scale(0.5);transform-origin:0 0}</style>
<p>Above the half size frame</p>
<iframe id="half" title="Half size form" src="{{other}}/frames/holder"></iframe>`,
  "/frames/holder": `<!doctype html><meta charset="utf-8"><title>Holder</title>
<style>body{margin:0}iframe{display:block;width:380px;height:220px;border:0;margin:20px 0 0}</style>
<p>Holder text</p>
<iframe id="grid" title="Inner grid" src="{{otherPort}}/frames/inner-grid"></iframe>`,
  // The grid page names no frameElement, which a frame from another origin
  // may not read, so its own handlers run wherever it is embedded.
  "/frames/inner-grid": `<!doctype html><meta charset="utf-8"><title>Inner grid</title>
<style>body{margin:0}button{position:absolute;width:100px;height:40px;margin:0;padding:0}</style>
<button type="button" id="target" style="left:100px;top:40px">Target</button>
<button type="button" id="decoy" style="left:260px;top:110px">Decoy</button>
<p id="grid-hit" role="status" style="position:absolute;left:0;top:160px;margin:0">Grid untouched</p>
<script>
for (const button of document.querySelectorAll("button"))
  button.onclick = () => { document.getElementById("grid-hit").textContent = "Grid hit " + button.textContent; };
</script>`,
  "/frames/scaled": `<!doctype html><meta charset="utf-8"><title>Scaled frames</title>
<style>body{margin:0}iframe{display:block;width:400px;height:200px;border:4px solid #666;padding:6px;margin:0 0 10px}#scaled{transform:scale(0.5);transform-origin:0 0}#zoomed{zoom:0.5}</style>
<iframe id="scaled" title="Scaled grid" src="/frames/grid"></iframe>
<iframe id="zoomed" title="Zoomed grid" src="/frames/grid"></iframe>`,
  "/frames/grid": `<!doctype html><meta charset="utf-8"><title>Grid</title>
<style>body{margin:0}button{position:absolute;width:100px;height:40px;margin:0;padding:0}</style>
<button type="button" id="target" style="left:100px;top:40px">Target</button>
<button type="button" id="decoy" style="left:260px;top:110px">Decoy</button>
<p id="grid-hit" role="status" style="position:absolute;left:0;top:160px;margin:0">Grid untouched</p>
<script>
for (const button of document.querySelectorAll("button"))
  button.onclick = () => { document.getElementById("grid-hit").textContent = frameElement.title + " hit " + button.textContent; };
</script>`,
  "/frames/twins": `<!doctype html><meta charset="utf-8"><title>Twin selectors</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:300px;height:80px;border:0}</style>
<button type="button" id="save" onclick="document.getElementById('twin-result').textContent='Outer saved'">Save</button>
<iframe id="twin" title="Twin form" src="/frames/twin"></iframe>
<p id="twin-result" role="status">Twins untouched</p>`,
  "/frames/twin": `<!doctype html><meta charset="utf-8"><title>Twin form</title>
<style>body{font:14px sans-serif;margin:8px}</style>
<p>Twin text</p>
<button type="button" class="twin" id="save" onclick="this.textContent='Frame saved'">Save</button>
<button type="button" class="twin" id="other" onclick="this.textContent='Other saved'">Other</button>`,
  "/frames/hidden": `<!doctype html><meta charset="utf-8"><title>Hidden frames</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:300px;height:100px;border:0}</style>
<p>Shown around the frames</p>
<iframe id="hidden" title="Hidden form" src="/frames/twin" style="visibility:hidden"></iframe>
<iframe id="collapsed" title="Collapsed form" src="/frames/twin" style="visibility:collapse"></iframe>
<x-veiled id="veiled" style="visibility:hidden"></x-veiled>
<script>
class XVeiled extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<p>Veiled text</p><button type="button">Veiled button</button>';
  }
}
customElements.define("x-veiled", XVeiled);
</script>`,
};
