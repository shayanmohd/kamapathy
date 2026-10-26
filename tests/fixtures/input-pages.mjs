// Pages the element actions are measured against: controls whose hit a
// banner, a modal, a bare box or their own interactive ancestors take, the
// disabled states a chain can carry, fields and selects of every kind, a
// panel inside a frame below the fold, drawn graphics, boxes that move or
// whose frames stall, a field and an editing host that log the key events
// they receive, a page that logs and may take the paste events it is sent,
// and the wrappers fill, select and focus retarget through. The end-to-end
// checks add banners that leave or stay, a log of the events a page
// received, fields a state object controls, and a drawing surface.
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
<p><label for="when">When</label> <input id="when" type="datetime-local"></p>
<p><label for="month">Month</label> <input id="month" type="month"></p>
<p><label for="week">Week</label> <input id="week" type="week"></p>
<p><label for="volume">Volume</label> <input id="volume" type="range" min="0" max="10"></p>
<p><label for="tint">Shade</label> <input id="tint" type="color" value="#336699"></p>
<p><label for="code">Code</label> <input id="code" type="text" value="Fixed" readonly></p>
<p><label for="jumpy">Jumpy</label> <input id="jumpy" type="text"></p>
<p><label for="currency">Currency</label> <input id="currency" type="text" value="0.00"></p>
<p><label for="slow">Slow</label> <input id="slow" type="text"></p>
<p><label for="notes">Notes</label> <div id="notes" contenteditable="true">Written <span id="note-word">here</span></div></p>
<p><label id="wrap">Nickname <input id="nick" type="text"></label></p>
<p><label for="secret">Password</label> <input id="secret" type="password"></p>
<div id="one-area"><textarea id="area" aria-label="Only area"></textarea></div>
<div id="two-fields"><input id="first" type="text" aria-label="First"> <input id="second" type="text" aria-label="Second"></div>
<div id="many-fields"><input id="shut" type="text" aria-label="Shut" disabled> <input id="one" type="text" aria-label="One"> <input id="two" type="text" aria-label="Two"> <input id="three" type="text" aria-label="Three"></div>
<div id="decoy"><input id="honey" type="text" aria-label="Honey" hidden> <input id="real" type="text" aria-label="Real"></div>
<div id="plain">Nothing to focus here</div>
<p id="kinds"><input id="pick" type="checkbox"> <input id="choice" type="radio" name="one-of"> <input id="upload" type="file"> <input id="token" type="hidden" value="kept"> <input id="picture" type="image" alt="Go" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"> <input id="go" type="button" value="Go"></p>
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
// A field a component rewrites twice after it changes, as a debounced
// formatter does, so a single read is not the value it settles on.
const slow = document.getElementById("slow");
slow.addEventListener("input", () => {
  setTimeout(() => (slow.value += "-one"), 20);
  setTimeout(() => (slow.value += "-two"), 60);
});
</script>`,
  "/input/selects": `<!doctype html><meta charset="utf-8"><title>Selects</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><label id="city-label" for="city">City</label> <select id="city"><option value="">Choose</option><option value="ams">Amsterdam</option><option value="blr">Bengaluru</option></select></p>
<p><select id="many" aria-label="Many options"></select></p>
<p><select id="several" multiple aria-label="Several"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></p>
<p><select id="sized" size="3" aria-label="Sized"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></p>
<p id="one-select"><select id="only" aria-label="Only select"><option value="a">Alpha</option><option value="b">Beta</option></select></p>
<p><select id="roles" aria-label="Roles"><option value="r">Reader</option><option value="w" disabled>Writer</option></select></p>
<p><select id="empty" aria-label="Empty"></select></p>
<p><select id="tricky" aria-label="Tricky"><option value="one">two</option><option value="two">three</option></select></p>
<p><span id="closed-root" style="display:inline-block"></span></p>
<div id="nothing-here">Nothing to choose here</div>
<script>
// A dropdown the page cannot reach: a closed shadow root keeps it out of
// selectors and out of the page's own hit test.
const buried = document
  .getElementById("closed-root")
  .attachShadow({ mode: "closed" });
buried.innerHTML =
  '<select id="buried"><option value="a">Alpha</option><option value="b">Beta</option></select>';
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
  "/input/scaled-frame": `<!doctype html><meta charset="utf-8"><title>Scaled frame</title>
<style>
body{font:14px sans-serif;margin:0}
iframe{display:block;border:0;width:400px;height:200px}
#scaled{transform:scale(0.5);transform-origin:0 0}
</style>
<iframe id="scaled" title="Flat grid" src="/input/flat-grid"></iframe>`,
  "/input/zoomed-frame": `<!doctype html><meta charset="utf-8"><title>Zoomed frame</title>
<style>
body{font:14px sans-serif;margin:0}
iframe{display:block;border:0;width:400px;height:200px}
#zoomed{zoom:0.5}
</style>
<iframe id="zoomed" title="Flat grid" src="/input/flat-grid"></iframe>`,
  // Everything this page draws is positioned, so its own root lies flat and
  // the frames around it are all that gives its pixels a size.
  "/input/flat-grid": `<!doctype html><meta charset="utf-8"><title>Flat grid</title>
<style>
body{font:14px sans-serif;margin:0}
button{position:absolute;left:100px;top:40px;width:100px;height:40px;margin:0;padding:0}
</style>
<button id="target" type="button">Target</button>`,
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
  "/input/drag": `<!doctype html><meta charset="utf-8"><title>Drag</title>
<style>
body{font:14px sans-serif;margin:0;height:1600px}
div{box-sizing:border-box;position:absolute}
#card{left:40px;top:300px;width:120px;height:40px;background:#dde}
#inner{left:8px;top:8px;width:40px;height:20px;background:#ccd}
#zone{left:240px;top:300px;width:160px;height:40px;background:#edd}
#blocked{left:40px;top:400px;width:160px;height:40px;background:#efe}
#shade{left:20px;top:380px;width:220px;height:80px;background:rgba(0,0,0,.3)}
#near{left:300px;top:760px;width:160px;height:40px;background:#eef}
#far{left:300px;top:1500px;width:160px;height:40px;background:#fee}
#rail{left:700px;top:0;width:80px;height:1200px}
#flat{left:600px;top:300px;width:0;height:0}
</style>
<div id="card" draggable="true">Card<div id="inner"></div></div>
<div id="zone">Drop zone</div>
<div id="blocked">Covered zone</div><div id="shade"></div>
<div id="near">Near zone</div>
<div id="far">Far zone</div>
<div id="rail">Rail</div>
<div id="flat"></div>`,
  "/input/keys": `<!doctype html><meta charset="utf-8"><title>Keys</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><label for="typed">Typed</label> <input id="typed" type="text"></p>
<p><label for="notes">Notes</label> <div id="notes" contenteditable="true">Written here</div></p>
<script>
// Every key event the page receives, as the page sees it.
window.keyLog = [];
for (const type of ["keydown", "keyup"])
  document.addEventListener(type, (event) => {
    window.keyLog.push({
      type: event.type,
      key: event.key,
      code: event.code,
      shift: event.shiftKey,
      meta: event.metaKey,
      trusted: event.isTrusted,
    });
  });
</script>`,
  "/input/paste": `<!doctype html><meta charset="utf-8"><title>Paste</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><label for="plain">Plain</label> <input id="plain" type="text"></p>
<p><label for="rich">Rich</label> <div id="rich" contenteditable="true">Rich text</div></p>
<p><button id="button" type="button">Nothing to type into</button></p>
<p><span id="shell" style="display:inline-block"></span></p>
<script>
// Every paste event the page receives, with the flavours it carries and the
// element it reached through the shadow boundary.
window.pasteLog = [];
// A page that takes the content for itself cancels the event; a test turns
// this on to play that handler.
window.takePaste = false;
document.addEventListener("paste", (event) => {
  const data = event.clipboardData;
  window.pasteLog.push({
    target: event.target.id,
    deep: event.composedPath()[0].id,
    types: Array.from(data.types),
    text: data.getData("text/plain"),
    html: data.getData("text/html"),
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    trusted: event.isTrusted,
  });
  if (window.takePaste) event.preventDefault();
});
document
  .getElementById("shell")
  .attachShadow({ mode: "open" })
  .append(Object.assign(document.createElement("input"), { id: "inner" }));
</script>`,
  "/input/stalled": `<!doctype html><meta charset="utf-8"><title>Stalled frames</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<button id="waiting" type="button">Waiting for a frame</button>
<script>
// A page whose frames never come, as a throttled tab's do not.
window.requestAnimationFrame = () => 0;
</script>`,
  "/input/banner": `<!doctype html><meta charset="utf-8"><title>Banners</title>
<style>
body{font:14px sans-serif;margin:0;height:600px}
#leaving,#staying{position:fixed;left:0;right:0;height:72px;color:#fff;padding:8px;box-sizing:border-box;z-index:5}
#leaving{top:0;background:#243}
#staying{top:160px;background:#423}
#under-leaving{position:absolute;left:24px;top:24px}
#under-staying{position:absolute;left:24px;top:184px}
#arm{position:absolute;left:24px;top:320px}
#clicks{position:absolute;left:24px;top:380px}
</style>
<div id="leaving" class="banner">Accept all cookies before this banner goes away on its own</div>
<button id="under-leaving" type="button">Under the leaving banner</button>
<div id="staying" class="banner">This banner stays over the button beneath it</div>
<button id="under-staying" type="button">Under the staying banner</button>
<button id="arm" type="button">Start the banner timer</button>
<p id="clicks" role="status">clicks none</p>
<script>
// The leaving banner goes 900 ms after the timer starts, so an action that
// waits reaches the button under it and one that does not never does. The
// timer starts on a click of its own, which keeps the banner in the way
// until the action under test begins.
const clicks = [];
for (const id of ["under-leaving", "under-staying"])
  document.getElementById(id).addEventListener("click", (event) => {
    clicks.push(id + (event.isTrusted ? " trusted" : " untrusted"));
    document.getElementById("clicks").textContent =
      "clicks " + clicks.join(", ");
  });
document.getElementById("arm").addEventListener("click", () => {
  setTimeout(() => {
    document.getElementById("leaving").style.display = "none";
  }, 900);
});
</script>`,
  "/input/events": `<!doctype html><meta charset="utf-8"><title>Event log</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><button id="action" type="button">Press me</button> <a id="link" href="#terms">Read the terms</a></p>
<p><label for="field">Field</label> <input id="field" type="text"></p>
<p><label for="choice">City</label> <select id="choice"><option value="">Choose</option><option value="ams">Amsterdam</option><option value="blr">Bengaluru</option></select></p>
<p id="log" role="status">log none</p>
<p id="value" role="status">value ""</p>
<script>
// What this page received, in order, in a status element, because the agent
// API reads pages and never runs code in them. A right click is left alone,
// so the browser is the only thing that can decide about a native menu.
const entries = [];
const log = document.getElementById("log");
const note = (text) => {
  entries.push(text);
  log.textContent = "log " + entries.join(" | ");
};
const field = document.getElementById("field");
const value = document.getElementById("value");
field.addEventListener("input", () => {
  value.textContent = 'value "' + field.value + '"';
});
for (const type of ["click", "dblclick", "contextmenu"])
  document.addEventListener(type, (event) => {
    note(
      type +
        " on " +
        event.target.id +
        " detail " +
        event.detail +
        (event.isTrusted ? " trusted" : " untrusted"),
    );
  });
document.addEventListener("keydown", (event) => {
  note(
    "keydown " +
      event.key +
      (event.shiftKey ? " shift" : "") +
      (event.isTrusted ? " trusted" : " untrusted"),
  );
});
document.getElementById("choice").addEventListener("change", (event) => {
  note("change " + event.target.value);
});
</script>`,
  "/input/controlled": `<!doctype html><meta charset="utf-8"><title>Controlled fields</title>
<style>body{font:14px sans-serif;margin:16px}p{margin:6px 0}</style>
<p><label for="name">Full name</label> <input id="name" type="text" value=""></p>
<p><label for="amount">Amount</label> <input id="amount" type="text" value="$0.00"></p>
<p id="state" role="status">name "" amount "$0.00"</p>
<p id="trust" role="status">trust none</p>
<script>
// Fields a component library drives: a state object is the only source of
// truth, every input event writes the field's value back from state, and an
// event the engine did not deliver changes nothing, so a value set from
// outside is thrown away exactly as a state hook throws it away.
const state = { name: "", amount: "$0.00" };
const nameField = document.getElementById("name");
const amount = document.getElementById("amount");
const report = document.getElementById("state");
const trust = document.getElementById("trust");
const seen = [];
const render = () => {
  nameField.value = state.name;
  amount.value = state.amount;
  report.textContent =
    'name "' + state.name + '" amount "' + state.amount + '"';
};
// A currency field that reformats whatever it is given, as a masked input
// does: 1234.5 comes back as $1,234.50.
const currency = (text) => {
  const given = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(given)
    ? "$" +
        given.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
    : "$0.00";
};
const controlled = (field, read) =>
  field.addEventListener("input", (event) => {
    seen.push(field.id + " " + event.isTrusted);
    trust.textContent = "trust " + seen.join(", ");
    if (event.isTrusted) read();
    render();
  });
controlled(nameField, () => (state.name = nameField.value));
controlled(amount, () => (state.amount = currency(amount.value)));
render();
</script>`,
  "/input/canvas": `<!doctype html><meta charset="utf-8"><title>Canvas</title>
<style>
body{font:14px sans-serif;margin:0}
#pad{position:absolute;left:0;top:0;touch-action:none}
#stroke{position:absolute;left:8px;top:220px;margin:0}
</style>
<canvas id="pad" width="300" height="200"></canvas>
<p id="stroke" role="status">stroke none</p>
<script>
// A drawing surface no selector can reach into: the stroke is the points the
// pointer visited while it was down, in the page's own viewport pixels, read
// back through a status element. Coalesced moves are read out, so a frame
// that merged two of them still reports both.
const pad = document.getElementById("pad");
const brush = pad.getContext("2d");
const readout = document.getElementById("stroke");
const points = [];
let untrusted = 0;
let drawing = false;
const add = (event) => {
  const merged = event.getCoalescedEvents?.() ?? [];
  for (const point of merged.length ? merged : [event]) {
    points.push(Math.round(point.clientX) + "," + Math.round(point.clientY));
    brush.lineTo(point.clientX, point.clientY);
  }
  if (!event.isTrusted) untrusted += 1;
  brush.stroke();
  readout.textContent =
    "stroke " +
    points.join(" ") +
    (untrusted ? " untrusted " + untrusted : " trusted");
};
pad.addEventListener("pointerdown", (event) => {
  drawing = true;
  brush.beginPath();
  brush.moveTo(event.clientX, event.clientY);
  add(event);
});
pad.addEventListener("pointermove", (event) => {
  if (drawing) add(event);
});
pad.addEventListener("pointerup", () => {
  drawing = false;
});
</script>`,
};
