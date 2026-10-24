// Pages the element actions are measured against: controls whose hit a
// banner, a modal, a bare box or their own interactive ancestors take, the
// disabled states a chain can carry, fields and selects of every kind, a
// panel inside a frame below the fold, drawn graphics, and boxes that move
// or whose frames stall.
export const inputPages = {
  "/input/buttons": `<!doctype html><meta charset="utf-8"><title>Buttons</title>
<style>
body{font:14px sans-serif;margin:0;height:900px}
#consent{position:fixed;left:0;top:0;right:0;height:64px;background:#222;color:#fff;padding:8px;box-sizing:border-box;z-index:5}
#under-banner{position:absolute;left:24px;top:24px}
#footer{position:fixed;left:0;bottom:0;right:0;height:40px;background:#eee;padding:8px;box-sizing:border-box}
#under-footer{position:fixed;left:24px;bottom:12px}
#shade{position:absolute;left:0;top:200px;width:300px;height:40px;background:rgba(0,0,0,.3)}
#overlaid{position:absolute;left:24px;top:208px}
#under-bare{position:absolute;left:24px;top:268px}
#under-marked{position:absolute;left:24px;top:328px}
#marked{position:absolute;left:0;top:320px;width:300px;height:40px;background:#edd}
#rows{position:absolute;left:400px;top:100px}
#row{padding:8px;background:#efe;width:260px}
#tiny{width:0;height:0;margin:0;padding:0;border:0;opacity:0}
label#agree-label{display:inline-block;padding:10px;background:#eef}
label#agree-label input{pointer-events:none}
#more-text,#link-text,#widget-text{pointer-events:none}
#stack{position:absolute;left:24px;top:420px}
dialog#confirm{position:fixed;left:0;top:500px;margin:0;width:360px;height:120px}
#behind{position:absolute;left:40px;top:540px}
</style>
<div id="consent" class="banner">Accept all cookies and the tracking they bring, so this site can measure every page you open and every button you press.</div>
<button id="under-banner" type="button">Under the banner</button>
<div id="stack">
<button id="save" type="button"><span id="save-text">Save</span></button>
<label id="agree-label"><input id="agree" type="checkbox"> I agree</label>
<details><summary id="more"><span id="more-text">More</span></summary><p id="more-body">The rest of it</p></details>
<a id="link" href="#read"><span id="link-text">Open the terms</span></a>
<div id="widget" role="button" tabindex="0"><span id="widget-text">Go</span></div>
</div>
<button id="overlaid" type="button">Overlaid</button><div id="shade"></div>
<button id="under-bare" type="button">Under a bare box</button>
<div style="position:absolute;left:0;top:260px;width:300px;height:40px;background:#dde"></div>
<button id="under-marked" type="button">Under marked text</button>
<div id="marked">&#x202e;Reversed&#x0007; text</div>
<button id="under-footer" type="button">Under the footer</button>
<div id="footer" class="bar">Site footer</div>
<button id="behind" type="button">Behind the modal</button>
<dialog id="confirm" aria-labelledby="confirm-title"><h2 id="confirm-title">Confirm delete</h2><button id="confirm-yes" type="button">Yes</button></dialog>
<div id="rows"><div id="row"><input id="tiny" type="radio" name="pick"> <span>Row choice</span></div></div>`,
  "/input/disabled": `<!doctype html><meta charset="utf-8"><title>Disabled states</title>
<style>body{font:14px sans-serif;margin:16px}fieldset{margin-bottom:12px}</style>
<fieldset id="billing" disabled>
<legend id="first-legend"><button id="in-legend" type="button">In the legend</button></legend>
<button id="in-fieldset" type="button">In the fieldset</button>
<span id="marked-in-fieldset" role="button" tabindex="0">Marked in the fieldset</span>
<legend id="second-legend"><button id="in-second-legend" type="button">In the second legend</button></legend>
</fieldset>
<fieldset id="shipping" disabled><span id="marked-alone" role="button" tabindex="0">Marked with no legend</span></fieldset>
<div id="bar" role="toolbar" aria-disabled="true"><button id="aria-off" type="button">Off</button></div>
<div role="toolbar" aria-disabled="true"><div role="group" aria-disabled="false"><button id="aria-on" type="button">On</button></div></div>
<div aria-disabled="true"><button id="aria-plain" type="button">Plain wrapper</button></div>
<button id="aria-self" type="button" aria-disabled="true">Self</button>
<select id="list" size="3">
<optgroup id="group" label="Group" disabled><option id="grouped">Grouped</option></optgroup>
<option id="dead" disabled>Dead</option>
<option id="live">Live</option>
</select>`,
  "/input/fields": `<!doctype html><meta charset="utf-8"><title>Fields</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><label for="name">Full name</label> <input id="name" type="text"></p>
<p><label for="email">Email</label> <input id="email" type="email"></p>
<p><label for="count">Count</label> <input id="count" type="number"></p>
<p><label for="day">Day</label> <input id="day" type="date"></p>
<p><label for="moment">Moment</label> <input id="moment" type="time"></p>
<p><label for="month">Month</label> <input id="month" type="month"></p>
<p><label for="week">Week</label> <input id="week" type="week"></p>
<p><label for="volume">Volume</label> <input id="volume" type="range" min="0" max="10"></p>
<p><label for="tint">Shade</label> <input id="tint" type="color" value="#336699"></p>
<p><label for="code">Code</label> <input id="code" type="text" value="Fixed" readonly></p>
<p><label for="jumpy">Jumpy</label> <input id="jumpy" type="text"></p>
<p><label for="currency">Currency</label> <input id="currency" type="text" value="0.00"></p>
<p><label for="notes">Notes</label> <div id="notes" contenteditable="true">Written here</div></p>
<p id="one-area"><textarea id="area" aria-label="Only area"></textarea></p>
<p id="two-fields"><input id="first" type="text" aria-label="First"> <input id="second" type="text" aria-label="Second"></p>
<script>
document.getElementById("jumpy").addEventListener("focus", () => {
  document.getElementById("name").focus();
});
// A controlled field that reformats what it is given, as a component library does.
const currency = document.getElementById("currency");
currency.addEventListener("input", () => {
  const digits = currency.value.replace(/[^0-9]/g, "");
  currency.value = digits ? (Number(digits) / 100).toFixed(2) : "0.00";
});
</script>`,
  "/input/selects": `<!doctype html><meta charset="utf-8"><title>Selects</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><label for="city">City</label> <select id="city"><option value="">Choose</option><option value="ams">Amsterdam</option><option value="blr">Bengaluru</option></select></p>
<p><select id="many" aria-label="Many options"></select></p>
<p><select id="several" multiple aria-label="Several"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></p>
<p><select id="sized" size="3" aria-label="Sized"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></p>
<p id="one-select"><select id="only" aria-label="Only select"><option value="a">Alpha</option><option value="b">Beta</option></select></p>
<script>
const many = document.getElementById("many");
for (let index = 1; index <= 30; index++) {
  const option = document.createElement("option");
  option.value = "v" + index;
  option.textContent = "Option " + index;
  many.append(option);
}
</script>`,
  "/input/scrollers": `<!doctype html><meta charset="utf-8"><title>Scrollers</title>
<style>
body{font:14px sans-serif;margin:0;height:2400px}
#panel-frame{display:block;border:0;width:400px;height:300px;position:absolute;left:250px;top:1200px}
#far{position:absolute;left:250px;top:2200px}
</style>
<p id="head" style="padding:16px">Top of a tall page</p>
<iframe id="panel-frame" title="Panel" src="/input/panel"></iframe>
<button id="far" type="button">Far down</button>`,
  "/input/panel": `<!doctype html><meta charset="utf-8"><title>Panel</title>
<style>
body{font:14px sans-serif;margin:0}
#panel{overflow:auto;height:200px;width:360px;border:1px solid #999;margin:20px}
#tall{height:1200px;position:relative}
#deep{position:absolute;left:20px;top:900px}
</style>
<div id="panel"><div id="tall"><button id="deep" type="button">Deep inside</button></div></div>`,
  "/input/graphics": `<!doctype html><meta charset="utf-8"><title>Graphics</title>
<style>body{font:14px sans-serif;margin:16px}svg{transform:scale(1.5);transform-origin:0 0;margin-bottom:60px}</style>
<svg id="chart" width="200" height="100"><g id="nothing"></g><rect id="bar" x="20" y="10" width="60" height="40" fill="#4a7"></rect></svg>
<p><math id="formula" style="font-size:24px"><mi id="variable">x</mi><mo>+</mo><mn>1</mn></math></p>`,
  "/input/moving": `<!doctype html><meta charset="utf-8"><title>Moving boxes</title>
<style>
body{font:14px sans-serif;margin:16px;height:600px}
button{position:absolute}
#drift{left:20px;top:100px}
#shake{left:20px;top:200px}
#still{left:20px;top:300px}
</style>
<button id="drift" type="button">Drifting</button>
<button id="shake" type="button">Shaking</button>
<button id="still" type="button">Still</button>
<script>
// Each frame moves one box a fifth of a pixel and the other a whole one, so
// two frames apart they have moved 0.4 and 2 pixels.
let offset = 0;
const drift = document.getElementById("drift");
const shake = document.getElementById("shake");
const step = () => {
  offset += 1;
  drift.style.left = 20 + offset * 0.2 + "px";
  shake.style.left = 20 + offset + "px";
  requestAnimationFrame(step);
};
requestAnimationFrame(step);
</script>`,
  "/input/stalled": `<!doctype html><meta charset="utf-8"><title>Stalled frames</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<button id="waiting" type="button">Waiting for a frame</button>
<script>
// A page whose frames never come, as a throttled tab's do not.
window.requestAnimationFrame = () => 0;
</script>`,
};
