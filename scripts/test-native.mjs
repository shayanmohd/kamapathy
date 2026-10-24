// Launches Kamapathy the way a person does, without Playwright, and drives an agent
// tab through its socket. Playwright's focus emulation marks every page it
// attaches to as visible, which hid agent pages that never painted: controls
// that animate in, native clicks, and screenshots all failed only outside tests.
import { prepareDesktopRuntime } from "./desktop-runtime.mjs";
import { poll } from "./wait.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveSocket,
  socketFetch,
} from "../skills/kamapathy/scripts/kamapathy.mjs";
import { framePages } from "../tests/fixtures/frame-pages.mjs";

const page = (body, script = "") =>
  `<!doctype html><html><body style="margin:20px">${body}<script>${script}</script></body></html>`;
const pages = {
  "/animated": page(
    `<style>@keyframes fade{to{opacity:1}}#go{opacity:0;animation:fade .3s forwards}</style><button id="go">Animated button</button>`,
  ),
  "/frames": page(
    `<p id="frames">frames 0</p><button id="go" hidden>Frame button</button>`,
    `let count=0;const tick=()=>{count++;document.getElementById('frames').textContent='frames '+count;if(count===2)document.getElementById('go').hidden=false;requestAnimationFrame(tick)};requestAnimationFrame(tick);`,
  ),
  "/click": page(
    `<button id="go" onclick="this.textContent='clicked'">Click me</button>`,
  ),
  "/drag": page(
    `<div id="item" draggable="true" style="width:120px;padding:12px;border:1px solid">Drag me</div><div id="zone" style="margin-top:40px;width:240px;height:80px;border:1px dashed">Drop here</div>`,
    `document.getElementById('item').ondragstart=(event)=>event.dataTransfer.setData('text/plain','item');const zone=document.getElementById('zone');zone.ondragover=(event)=>event.preventDefault();zone.ondrop=(event)=>{event.preventDefault();zone.textContent='dropped '+event.dataTransfer.getData('text/plain');};`,
  ),
  "/timers": page(
    `<p id="ticks">Counting timer ticks</p>`,
    `let ticks=0;const timer=setInterval(()=>ticks++,16);setTimeout(()=>{clearInterval(timer);document.getElementById('ticks').textContent='ticks '+ticks;},1000);`,
  ),
  "/opener": page(
    `<button id="open">Open popup</button>`,
    `document.getElementById('open').onclick=()=>window.open('/popup-timers');`,
  ),
  "/popup-timers": page(
    `<p id="ticks">Counting timer ticks</p><button id="go" onclick="this.textContent='popup clicked'">Popup button</button>`,
    `let ticks=0;const timer=setInterval(()=>ticks++,16);setTimeout(()=>{clearInterval(timer);document.getElementById('ticks').textContent='ticks '+ticks;},1000);`,
  ),
  "/tall": `<!doctype html><html><body style="margin:0"><h1 style="margin:0;height:40px">Tall page</h1><div style="height:2400px"></div><p id="sizes" style="margin:0;height:20px">sizes</p><script>document.getElementById('sizes').textContent='viewport '+Math.floor(visualViewport.width)+'x'+Math.floor(visualViewport.height)+' document '+document.documentElement.scrollWidth+'x'+document.documentElement.scrollHeight;</script></body></html>`,
  "/audio": page(
    `<button id="play">Play sound</button><p id="sound">Silent</p>`,
    `document.getElementById('play').onclick=()=>{const audio=new Audio('/silence.wav');audio.ontimeupdate=()=>{if(audio.currentTime>0.15)document.getElementById('sound').textContent='played';};audio.play().catch((error)=>{document.getElementById('sound').textContent='refused '+error.name;});};`,
  ),
  // The page asks for an image, fetches, starts a worker that fetches and
  // registers a service worker that fetches, then reports what it sees of
  // itself. Every request shows the server its identity.
  "/identity": page(
    `<p id="identity">Reading this browser's identity</p>`,
    `new Image().src='/identity/pixel.png';new Worker('/identity/worker.js');navigator.serviceWorker.register('/identity/sw.js').catch(()=>{});(async()=>{await fetch('/identity/from-page');const hints=await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);await fetch('/report',{method:'POST',body:JSON.stringify({userAgent:navigator.userAgent,brands:navigator.userAgentData.brands,fullVersionList:hints.fullVersionList,pdfViewerEnabled:navigator.pdfViewerEnabled})});document.getElementById('identity').textContent='Identity reported';})();`,
  ),
  ...framePages,
};
// Each identity request's own User-Agent and Sec-CH-UA, by path.
const IDENTITY_PATHS = [
  "/identity",
  "/identity/pixel.png",
  "/identity/from-page",
  "/identity/from-worker",
  "/identity/from-sw",
];
const seen = new Map();
let identity;
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
// One second of 8 kHz, 8-bit mono PCM: a 44-byte RIFF header, then 8000
// samples at the silent midpoint 0x80.
const silence = Buffer.alloc(44 + 8000, 0x80);
silence.write("RIFF", 0, "ascii");
silence.writeUInt32LE(36 + 8000, 4);
silence.write("WAVEfmt ", 8, "ascii");
silence.writeUInt32LE(16, 16);
silence.writeUInt16LE(1, 20);
silence.writeUInt16LE(1, 22);
silence.writeUInt32LE(8000, 24);
silence.writeUInt32LE(8000, 28);
silence.writeUInt16LE(1, 32);
silence.writeUInt16LE(8, 34);
silence.write("data", 36, "ascii");
silence.writeUInt32LE(8000, 40);
const site = createServer(async (request, response) => {
  const path = new URL(request.url, "http://x").pathname;
  if (path === "/silence.wav") {
    response.writeHead(200, { "Content-Type": "audio/wav" });
    return response.end(silence);
  }
  if (IDENTITY_PATHS.includes(path))
    seen.set(path, {
      userAgent: request.headers["user-agent"],
      hints: request.headers["sec-ch-ua"],
    });
  if (path === "/report") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    identity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "text/plain" });
    return response.end("ok");
  }
  if (path === "/identity/pixel.png") {
    response.writeHead(200, { "Content-Type": "image/png" });
    return response.end(pixel);
  }
  // A service worker needs a secure context, which http://127.0.0.1 is.
  if (path === "/identity/worker.js" || path === "/identity/sw.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return response.end(
      `fetch('/identity/from-${path.endsWith("sw.js") ? "sw" : "worker"}');\n`,
    );
  }
  if (path.startsWith("/identity/from-")) {
    response.writeHead(204);
    return response.end();
  }
  const html = pages[path];
  response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
  response.end(html || "");
});
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${site.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "kamapathy-native-"));
const env = { ...process.env, KAMAPATHY_USER_DATA: profile, KAMAPATHY_NO_LAUNCH: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const kamapathy = spawn(await prepareDesktopRuntime(), [resolve("out/main/index.js")], {
  env,
  stdio: "ignore",
});
const checks = [];
const passed = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  const connection = await poll(() => resolveSocket(env).catch(() => null), {
    timeoutMs: 60000,
    label: "Kamapathy's agent socket",
  });
  const send = socketFetch(connection);
  const api = async (path, method = "GET", body) => {
    const response = await send(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, response };
  };
  const json = async (...args) => (await api(...args)).response.json();
  passed("a normally launched Kamapathy accepts agents with no setup");
  const { space } = await json("/spaces", "POST", { name: "Native render" });
  const open = async (path) =>
    (await json(`/spaces/${space.id}/tabs`, "POST", { url: `${origin}${path}` }))
      .tab.id;
  const snapshot = (tab, extra = "") => json(`/tabs/${tab}/snapshot${extra}`);
  const controls = async (tab) =>
    (await snapshot(tab)).interactables.map((control) => control.label);

  const animated = await open("/animated");
  await poll(async () => (await controls(animated)).includes("Animated button"), {
    timeoutMs: 10000,
    label: "an animated control in an unwatched agent tab",
  });
  passed("controls that animate in become visible in an unwatched agent tab");

  const frames = await open("/frames");
  await poll(async () => (await controls(frames)).includes("Frame button"), {
    timeoutMs: 10000,
    label: "animation frames in an unwatched agent tab",
  });
  passed("unwatched agent tabs run animation frames");

  const click = await open("/click");
  await poll(async () => (await controls(click)).includes("Click me"), {
    timeoutMs: 10000,
    label: "the click fixture",
  });
  const clicked = await api(`/tabs/${click}/click`, "POST", { selector: "#go" });
  assert.equal(clicked.status, 200, JSON.stringify(await clicked.response.json()));
  assert.ok((await controls(click)).includes("clicked"));
  passed("native clicks reach an unwatched agent tab");

  const drag = await open("/drag");
  await poll(async () => (await controls(drag)).includes("Drag me"), {
    timeoutMs: 10000,
    label: "the drag fixture",
  });
  const dragged = await api(`/tabs/${drag}/drag`, "POST", {
    source: { selector: "#item" },
    target: { selector: "#zone" },
  });
  const dragResult = await dragged.response.json();
  assert.equal(dragged.status, 200, JSON.stringify(dragResult));
  assert.equal(dragResult.drag, "html5");
  assert.match((await snapshot(drag)).text, /dropped item/);
  passed("HTML5 drags reach an unwatched agent tab");

  const byLabel = (page, label) =>
    page.interactables.find((control) => control.label === label);
  const shadow = await open("/frames/shadow");
  await poll(async () => (await controls(shadow)).includes("Save preferences"), {
    timeoutMs: 10000,
    label: "the shadow root fixture",
  });
  const shadowPage = await snapshot(shadow);
  assert.match(shadowPage.text, /Notifications[\s\S]*Rendered in the shadow root/);
  assert.doesNotMatch(shadowPage.text, /Not shown/);
  assert.deepEqual(
    shadowPage.interactables.map((control) => control.label),
    ["Email alerts", "Save preferences", "Slotted action"],
  );
  const saved = await api(`/tabs/${shadow}/click`, "POST", {
    ref: byLabel(shadowPage, "Save preferences").ref,
  });
  assert.equal(saved.status, 200, JSON.stringify(await saved.response.json()));
  assert.match((await snapshot(shadow)).text, /Saved from shadow/);
  passed("snapshots list and click controls inside open shadow roots");

  const embedded = await open("/frames/outer");
  const outer = await poll(
    async () => {
      const page = await snapshot(embedded);
      return byLabel(page, "Deep button") && byLabel(page, "Card details")?.crossOrigin
        ? page
        : null;
    },
    { timeoutMs: 10000, label: "the frames fixture" },
  );
  assert.match(
    outer.text,
    /Text above the frame[\s\S]*Text inside the frame[\s\S]*Text two frames deep[\s\S]*Outer untouched/,
  );
  assert.equal(byLabel(outer, "Frame note").frame, "0");
  assert.equal(byLabel(outer, "Deep button").frame, "0/0");
  assert.equal(byLabel(outer, "Card details").frame, undefined);
  assert.equal(byLabel(outer, "Card details").role, "iframe");
  const deep = await api(`/tabs/${embedded}/click`, "POST", {
    ref: byLabel(outer, "Deep button").ref,
  });
  assert.equal(deep.status, 200, JSON.stringify(await deep.response.json()));
  assert.match((await snapshot(embedded)).text, /Deep clicked/);
  passed("native clicks reach a button two same-origin frames deep");

  const filled = await api(`/tabs/${embedded}/fill`, "POST", {
    selector: "#note",
    value: "hello",
  });
  assert.equal(filled.status, 200, JSON.stringify(await filled.response.json()));
  const entered = await api(`/tabs/${embedded}/press`, "POST", {
    key: "Enter",
    ref: byLabel(outer, "Frame note").ref,
  });
  assert.equal(entered.status, 200, JSON.stringify(await entered.response.json()));
  const waited = await api(`/tabs/${embedded}/wait`, "POST", {
    text: "Entered hello",
    timeoutMs: 3000,
  });
  assert.equal(waited.status, 200, JSON.stringify(await waited.response.json()));
  const scoped = await json(`/tabs/${embedded}/snapshot`, "POST", {
    selector: "#inner-result",
  });
  assert.equal(scoped.text, "Entered hello");
  const uploaded = await api(`/tabs/${embedded}/upload`, "POST", {
    ref: byLabel(outer, "Frame file").ref,
    files: [{ name: "note.txt", type: "text/plain", data: Buffer.from("hi").toString("base64") }],
  });
  assert.equal(uploaded.status, 200, JSON.stringify(await uploaded.response.json()));
  assert.match((await snapshot(embedded)).text, /Files 1/);
  passed("fill, key presses, waits, scoped snapshots and uploads work inside a frame");

  const blocked = await api(`/tabs/${embedded}/click`, "POST", {
    ref: byLabel(outer, "Card details").ref,
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.response.json()).error.code, "cross_origin_frame");
  passed("a frame from another origin is listed and refuses actions");

  const hosted = await open("/frames/shadow-frame");
  const widget = await poll(
    async () => {
      const page = await snapshot(hosted);
      return byLabel(page, "Count clicks") ? page : null;
    },
    { timeoutMs: 10000, label: "the shadow hosted frame fixture" },
  );
  assert.equal(byLabel(widget, "Count clicks").frame, "0");
  const counted = await api(`/tabs/${hosted}/click`, "POST", {
    ref: byLabel(widget, "Count clicks").ref,
  });
  assert.equal(counted.status, 200, JSON.stringify(await counted.response.json()));
  assert.match((await snapshot(hosted)).text, /Counted 1/);
  const word = byLabel(widget, "Embedded word").ref;
  const typed = await api(`/tabs/${hosted}/fill`, "POST", { ref: word, value: "hi" });
  assert.equal(typed.status, 200, JSON.stringify(await typed.response.json()));
  const pressed = await api(`/tabs/${hosted}/press`, "POST", { key: "Enter", ref: word });
  assert.equal(pressed.status, 200, JSON.stringify(await pressed.response.json()));
  assert.match((await snapshot(hosted)).text, /Entered hi/);
  passed("native clicks and key presses reach a frame hosted by a shadow root");

  const scroller = await open("/frames/scroller");
  const list = await poll(
    async () => {
      const page = await snapshot(scroller);
      return byLabel(page, "First item") ? page : null;
    },
    { timeoutMs: 10000, label: "the frame scroller fixture" },
  );
  const scrolled = await json(`/tabs/${scroller}/scroll`, "POST", {
    direction: "down",
    pixels: 600,
    ref: byLabel(list, "First item").ref,
  });
  assert.deepEqual(
    [scrolled.scrolled, scrolled.y, scrolled.moved],
    ["page", 600, true],
    JSON.stringify(scrolled),
  );
  passed("scrolling a control inside a frame scrolls that frame");

  const scaled = await open("/frames/scaled");
  const grids = await poll(
    async () => {
      const page = await snapshot(scaled);
      const targets = page.interactables.filter((control) => control.label === "Target");
      return targets.length === 2 ? page : null;
    },
    { timeoutMs: 10000, label: "the scaled frames fixture" },
  );
  for (const [frame, title] of [["0", "Scaled grid"], ["1", "Zoomed grid"]]) {
    const control = grids.interactables.find(
      (control) => control.label === "Target" && control.frame === frame,
    );
    const hit = await api(`/tabs/${scaled}/click`, "POST", { ref: control.ref });
    assert.equal(hit.status, 200, JSON.stringify(await hit.response.json()));
    assert.match((await snapshot(scaled)).text, new RegExp(`${title} hit Target`));
  }
  passed("native clicks land inside frames drawn at another scale");

  // No window shows this tab, so Chromium does not paint its view and the
  // capture runs through the capture window. The page measured its own
  // viewport and document before anything captured it.
  const tall = await open("/tall");
  const measured = await poll(
    async () =>
      /viewport (\d+)x(\d+) document (\d+)x(\d+)/.exec((await snapshot(tall)).text),
    { timeoutMs: 10000, label: "the tall page's own measurements" },
  );
  const [viewportWidth, viewportHeight, documentWidth, documentHeight] = measured
    .slice(1)
    .map(Number);
  assert.ok(
    documentHeight > viewportHeight,
    `A document of ${documentHeight} pixels is no taller than its viewport`,
  );
  const shot = await api(`/tabs/${tall}/screenshot`);
  assert.equal(shot.status, 200);
  const png = Buffer.from(await shot.response.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(
    [png.readUInt32BE(16), png.readUInt32BE(20)],
    [viewportWidth, viewportHeight],
  );
  const whole = await api(`/tabs/${tall}/screenshot`, "POST", { fullPage: true });
  assert.equal(whole.status, 200);
  const wholePng = Buffer.from(await whole.response.arrayBuffer());
  assert.deepEqual(
    [wholePng.readUInt32BE(16), wholePng.readUInt32BE(20)],
    [documentWidth, documentHeight],
  );
  passed(
    "screenshots of an unwatched agent tab come out at CSS size, and a full-page capture covers its document",
  );

  const timers = await open("/timers");
  const ticked = await poll(
    async () => /ticks (\d+)/.exec((await snapshot(timers)).text),
    { timeoutMs: 10000, label: "a second of timer ticks in an unwatched agent tab" },
  );
  assert.ok(
    Number(ticked[1]) >= 30,
    `Only ${ticked[1]} ticks of a 16 ms interval ran in one second`,
  );
  passed("an unwatched agent tab keeps 60 Hz timers with its session attached");

  const audio = await open("/audio");
  await poll(async () => (await controls(audio)).includes("Play sound"), {
    timeoutMs: 10000,
    label: "the audio fixture",
  });
  const play = await api(`/tabs/${audio}/click`, "POST", { selector: "#play" });
  assert.equal(play.status, 200, JSON.stringify(await play.response.json()));
  const played = await api(`/tabs/${audio}/wait`, "POST", {
    selector: "#sound",
    text: "played",
    timeoutMs: 5000,
  });
  assert.equal(played.status, 200, JSON.stringify(await played.response.json()));
  passed("an unwatched agent tab plays audio after a native click");

  // A popup is adopted as a hidden tab no one watches. Without Kamapathy
  // turning throttling off, its timers would crawl and it would take no
  // input.
  const opener = await open("/opener");
  await poll(async () => (await controls(opener)).includes("Open popup"), {
    timeoutMs: 10000,
    label: "the popup opener",
  });
  const opened = await api(`/tabs/${opener}/click`, "POST", { selector: "#open" });
  assert.equal(opened.status, 200, JSON.stringify(await opened.response.json()));
  const popup = await poll(
    async () =>
      (await json(`/spaces/${space.id}/tabs`)).tabs.find((tab) =>
        tab.url.endsWith("/popup-timers"),
      ),
    { timeoutMs: 10000, label: "the popup tab" },
  );
  assert.equal(popup.managed, true);
  assert.equal(popup.openerId, opener);
  const popupTicks = await poll(
    async () => /ticks (\d+)/.exec((await snapshot(popup.id)).text),
    { timeoutMs: 10000, label: "a second of timer ticks in the popup" },
  );
  assert.ok(
    Number(popupTicks[1]) >= 30,
    `Only ${popupTicks[1]} ticks of a 16 ms interval ran in the popup in one second`,
  );
  const popupClick = await api(`/tabs/${popup.id}/click`, "POST", { selector: "#go" });
  assert.equal(popupClick.status, 200, JSON.stringify(await popupClick.response.json()));
  assert.ok((await controls(popup.id)).includes("popup clicked"));
  passed("a background popup from an unwatched agent tab runs timers at full rate and takes a native click");

  // Section 16: what every request tells a site about this browser.
  await open("/identity");
  await poll(
    () => identity && IDENTITY_PATHS.every((path) => seen.has(path)),
    { timeoutMs: 20000, label: "the navigation, image, fetch, worker and service worker requests" },
  );
  const agents = IDENTITY_PATHS.map((path) => seen.get(path).userAgent);
  assert.equal(new Set(agents).size, 1, JSON.stringify(agents));
  assert.doesNotMatch(agents[0], /Kamapathy|Electron/i);
  assert.match(
    agents[0],
    /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/,
  );
  passed("navigations, images, fetches, workers and service workers all send the Chrome-compatible user agent");

  const { versions } = await json("/health");
  const major = versions.chromium.split(".")[0];
  assert.match(agents[0], new RegExp(`Chrome/${major}\\.0\\.0\\.0 `));
  assert.equal(identity.userAgent, agents[0]);
  assert.ok(
    !identity.userAgent.includes(versions.chromium),
    `The user agent carries the full version ${versions.chromium}`,
  );
  assert.deepEqual(
    identity.fullVersionList.find((brand) => brand.brand === "Chromium"),
    { brand: "Chromium", version: versions.chromium },
  );
  passed("the user agent zeroes the minor, build and patch while the client hints keep the full Chromium version");

  // Chromium sends its hints with the requests a page makes; a navigation the
  // shell starts carries none, so the page's own fetch is where they show.
  const hints = seen.get("/identity/from-page").hints;
  assert.match(hints, new RegExp(`"Chromium";v="${major}"`));
  assert.doesNotMatch(hints, /Google Chrome/);
  assert.ok(
    identity.brands.some(
      (brand) => brand.brand === "Chromium" && brand.version === major,
    ),
    JSON.stringify(identity.brands),
  );
  assert.ok(!identity.brands.some((brand) => brand.brand === "Google Chrome"));
  passed("Chromium's own client hints reach sites, with no Google Chrome brand");

  assert.equal(identity.pdfViewerEnabled, true);
  passed("an agent tab reports Chromium's PDF viewer as available");

  console.log(`Native launch passed: ${checks.length} checks.`);
} finally {
  kamapathy.kill();
  await new Promise((done) => (kamapathy.exitCode === null ? kamapathy.once("exit", done) : done()));
  site.close();
  site.closeAllConnections();
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
