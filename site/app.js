const REPO = "shayanmohd/kamapathy";
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? "⌘" : "Ctrl+";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (name) => `<svg><use href="#i-${name}" /></svg>`;

// Theme

const root = document.documentElement;
const media = matchMedia("(prefers-color-scheme: dark)");
const currentTheme = () => root.dataset.theme || (media.matches ? "dark" : "light");
function setTheme(theme) {
  root.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {}
  syncTheme();
}
function syncTheme() {
  const dark = currentTheme() === "dark";
  $("#theme-toggle").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  showTour(tourIndex);
}
$("#theme-toggle").addEventListener("click", () =>
  setTheme(currentTheme() === "dark" ? "light" : "dark"),
);
media.addEventListener("change", syncTheme);

const nav = $(".nav");
const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

for (const key of $$("[data-mod]")) key.textContent = isMac ? "⌘" : "Ctrl";

// Demo: a small model of the browser drawn at 960 by 600 and scaled to fit.

const mock = $("[data-mock]");
const frame = $("[data-demo-frame]");
const layer = $("[data-layer]");
const cursor = $("[data-cursor]");
const caption = $("[data-demo-caption]");
let scale = 1;
new ResizeObserver(() => {
  scale = frame.clientWidth / 960;
  mock.style.setProperty("--scale", scale);
}).observe(frame);

let demoVisible = false;
new IntersectionObserver(([entry]) => (demoVisible = entry.isIntersecting), {
  threshold: 0.3,
}).observe(frame);

const say = (text) => (caption.textContent = text);

const makeSpaces = () => [
  {
    id: "personal",
    name: "Personal",
    color: "#6f8f5f",
    active: 0,
    tabs: [
      { title: "The quiet web", host: "journal.example", path: "/essays/the-quiet-web", page: "article", icon: "#9a6b2f" },
      { title: "Ridge loop trail", host: "maps.example", path: "/trails/ridge-loop", page: "map", icon: "#4f7fa8" },
      { title: "New tab", page: "newtab" },
    ],
  },
  {
    id: "work",
    name: "Work",
    color: "#6f86b8",
    active: 0,
    tabs: [
      { title: "Launch checklist", host: "docs.example", path: "/team/launch", page: "doc", icon: "#6f86b8" },
      { title: "Inbox (3)", host: "mail.example", path: "/inbox", page: "inbox", icon: "#c0462b" },
    ],
  },
];

let spaces = makeSpaces();
let current = 0;
let agent = null;
let agentRun = 0;
let confirmingStop = false;
let spaceCount = 2;

const space = () => spaces[current];
const tab = () => space().tabs[space().active];
const agentSpace = () => spaces.find((item) => item.agent);
const viewingAgent = () => Boolean(space().agent);

function favicon(item) {
  if (item.page === "newtab") return icon("magnifying-glass");
  return `<span class="favicon" style="background:${item.icon}"></span>`;
}

function renderTabs() {
  const strip = $("[data-tabs]");
  strip.innerHTML = space()
    .tabs.map(
      (item, index) => `
        <div class="mock-tab ${index === space().active ? "active" : ""}" role="tab" aria-selected="${index === space().active}" tabindex="0" data-tab="${index}">
          ${favicon(item)}
          <span class="title">${escapeHtml(item.title)}</span>
          <button class="close" type="button" data-close="${index}" aria-label="Close ${escapeHtml(item.title)}">${icon("x")}</button>
        </div>`,
    )
    .join("");
}

function renderAddress() {
  const item = tab();
  $("[data-host]").textContent = item.page === "newtab" ? "" : item.host;
  $("[data-path]").textContent = item.page === "newtab" ? "Search or enter a URL" : item.path;
}

const pages = {
  article: () => `
    <div class="page-content">
      <div class="kicker">Essay</div>
      <h2>The quiet web</h2>
      <p>Some of the best corners of the internet are the slow ones: a long read, a trail report, a recipe someone has cooked for twenty years.</p>
      <div class="hero-art"></div>
      <div class="skeleton" style="width:94%"></div>
      <div class="skeleton" style="width:88%"></div>
      <div class="skeleton" style="width:91%"></div>
      <div class="skeleton" style="width:60%"></div>
    </div>`,
  map: () => `
    <div class="page-content" style="position:relative;padding:0">
      <div class="map">
        <svg viewBox="0 0 944 470" preserveAspectRatio="none">
          <path d="M-10 380 C 180 330 260 420 420 330 S 700 160 960 200" stroke="#fff" stroke-width="14" />
          <path d="M300 -10 C 330 120 280 260 360 480" stroke="#fff" stroke-width="10" />
          <path d="M140 400 C 220 300 330 330 430 250 S 610 120 760 150 S 820 300 700 340 S 420 420 300 390" stroke="#c0462b" stroke-width="4" stroke-dasharray="1 9" stroke-linecap="round" />
        </svg>
      </div>
      <div class="map-card"><h2>Ridge loop</h2><p>7.4 km · about 3 hours · moderate</p></div>
    </div>`,
  doc: () => `
    <div class="page-content">
      <div class="kicker" style="color:#4f6fa8">Team docs</div>
      <h2>Launch checklist</h2>
      <p>Everything left before Friday's release.</p>
      <ul class="doc-list">
        <li class="done">Write the release notes</li>
        <li class="done">Record the product tour</li>
        <li>Check the download page on every platform</li>
        <li>Send the announcement</li>
        <li>Celebrate</li>
      </ul>
    </div>`,
  inbox: () => `
    <div class="page-content">
      <h2 style="font:600 22px -apple-system,system-ui,sans-serif">Inbox</h2>
      ${[
        ["Maya Chen", "Design review moved to Thursday", "9:41"],
        ["Build bot", "All four desktop builds passed", "9:12"],
        ["Jonas", "Photos from the offsite", "Mon"],
        ["Calendar", "Dinner with Sam, Friday", "Sun"],
      ]
        .map(([from, subject, when]) => `<div class="inbox-row"><b>${from}</b><span>${subject}</span><i>${when}</i></div>`)
        .join("")}
    </div>`,
  newtab: () => `
    <div class="newtab">
      <div class="search">${icon("magnifying-glass")}Search the web or enter a URL</div>
      <div class="tiles">
        ${[["J", "Journal"], ["M", "Maps"], ["D", "Docs"], ["@", "Mail"]]
          .map(([letter, name]) => `<span class="tile"><i>${letter}</i>${name}</span>`)
          .join("")}
        <span class="tile"><i>${icon("plus")}</i>Add shortcut</span>
      </div>
    </div>`,
  booking: (item) => {
    const form = item.form;
    if (item.stage === "confirmed")
      return `
        <div class="page-content confirmed">
          <span class="badge">${icon("check")}</span>
          <h2>You're booked</h2>
          <p>Table for ${escapeHtml(form.party.replace(" people", ""))} at Luca, ${escapeHtml(form.time)}.<br />A confirmation is on its way to ${escapeHtml(form.email)}.</p>
        </div>`;
    if (item.stage === "signin")
      return `
        <div class="page-content">
          <div class="signin ${item.signedIn ? "done" : ""}">
            <h2>${item.signedIn ? "Welcome back, Sam" : "Sign in to finish"}</h2>
            <p>${item.signedIn ? "Your table is held for 10 minutes." : "Luca holds your table while you sign in."}</p>
            <div class="fake-field">${item.signedIn ? "sam@example.com" : "Email"}</div>
            <div class="fake-field">${item.signedIn ? "••••••••••" : "Password"}</div>
            ${
              item.signedIn
                ? `<button type="button" data-field="confirm">Confirm booking</button>`
                : `<button type="button" data-signin>Sign in</button>`
            }
          </div>
        </div>`;
    return `
      <div class="page-content">
        <div class="kicker">Luca · Trattoria</div>
        <div class="booking">
          <div>
            <h2>Reserve a table</h2>
            <p>Handmade pasta, a short wine list, and a garden in the back.</p>
            <form>
              <label>Name<input data-field="name" placeholder="Your name" value="${escapeHtml(form.name)}" readonly tabindex="-1" /></label>
              <label>Party size<input data-field="party" placeholder="Choose" value="${escapeHtml(form.party)}" readonly tabindex="-1" /></label>
              <label>Time<input data-field="time" placeholder="Choose a time" value="${escapeHtml(form.time)}" readonly tabindex="-1" /></label>
              <button type="button" class="submit" data-field="submit" tabindex="-1">Reserve</button>
            </form>
          </div>
          <div class="aside"><div class="food"></div><div><b>Tonight's special</b>Tagliatelle with slow-cooked ragù.</div></div>
        </div>
      </div>`;
  },
};

function renderPage(flash = false) {
  const page = $("[data-page]");
  page.innerHTML = pages[tab().page](tab());
  if (flash) {
    page.firstElementChild.classList.add("reload-flash");
  }
}

function renderChrome() {
  const agentState = agent?.state;
  const inAgent = viewingAgent() && agent;
  mock.classList.toggle("working", agentState === "browsing");
  mock.classList.toggle("needs-you", agentState === "needs-you" && !viewingAgent());
  mock.classList.toggle("agent-view", Boolean(inAgent) && !["off", "stopped"].includes(agentState));
  mock.classList.toggle("paused", agentState === "in-control" || agentState === "needs-you");
  mock.classList.toggle("idle", ["idle", "off", "stopped"].includes(agentState));
  $(".space-button").style.setProperty("--space-color", space().color);
  $(".space-button").setAttribute(
    "aria-label",
    [
      `Spaces: ${space().name}`,
      agentState === "browsing" ? "1 agent working" : "",
      agentState === "needs-you" ? "an agent needs you" : "",
    ]
      .filter(Boolean)
      .join(", "),
  );

  const bar = $("[data-agent-bar]");
  bar.hidden = !inAgent;
  if (!inAgent) return;
  $("[data-agent-name]").textContent = space().name;
  const status = {
    browsing: "Agent is browsing",
    idle: "Agent is idle",
    "in-control": "You're in control",
    "needs-you": "You're in control",
    stopped: "You stopped the agent",
    off: "Agent access is off",
  }[agentState];
  $("[data-agent-status]").textContent = confirmingStop
    ? "Stop the agent in this space?"
    : status;
  const [takeOver, resume, stop, stopAll] = $$("button", bar);
  takeOver.hidden = !confirmingStop && !["browsing", "idle"].includes(agentState);
  takeOver.textContent = confirmingStop ? "Cancel" : "Take over";
  resume.hidden = confirmingStop || !["in-control", "needs-you"].includes(agentState);
  stop.hidden = ["off", "stopped"].includes(agentState);
  stop.classList.toggle("confirm", confirmingStop);
  stopAll.hidden = !confirmingStop;
}

function render() {
  renderTabs();
  renderAddress();
  renderPage();
  renderChrome();
  if (!viewingAgent() || agent?.state !== "browsing") cursor.classList.remove("on");
}

function closeLayer() {
  layer.innerHTML = "";
}

function selectSpace(index) {
  current = index;
  closeLayer();
  render();
}

function selectTab(index) {
  space().active = index;
  render();
}

function newTab() {
  space().tabs.push({ title: "New tab", page: "newtab" });
  space().active = space().tabs.length - 1;
  closeLayer();
  render();
}

function closeTab(index) {
  const tabs = space().tabs;
  if (tabs.length === 1) {
    tabs[0] = { title: "New tab", page: "newtab" };
  } else {
    tabs.splice(index, 1);
    if (space().active >= tabs.length) space().active = tabs.length - 1;
    else if (space().active > index) space().active -= 1;
  }
  render();
}

// Popovers and overlays

function showSpaces() {
  const agents = spaces
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.agent);
  const people = spaces
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.agent);
  const agentMeta = {
    browsing: "Working",
    idle: "Idle",
    "in-control": "You're in control",
    "needs-you": "Needs you",
    stopped: "You stopped the agent",
    off: "Off",
  };
  layer.innerHTML = `
    <div class="popover" style="top:40px;right:10px;width:290px" role="menu" aria-label="Spaces">
      ${
        agents.length
          ? `<h4>Agents</h4>${agents
              .map(
                ({ item, index }) =>
                  `<button class="row" role="menuitem" data-space="${index}"><span class="dot ring" style="--dot:${item.color}"></span>${escapeHtml(item.name)}<span class="meta">${agentMeta[agent?.state] || "Idle"}</span></button>`,
              )
              .join("")}`
          : ""
      }
      <h4>Your spaces</h4>
      ${people
        .map(
          ({ item, index }) =>
            `<button class="row" role="menuitem" data-space="${index}"><span class="dot" style="--dot:${item.color}"></span>${escapeHtml(item.name)}<span class="meta">${item.tabs.length} ${item.tabs.length === 1 ? "tab" : "tabs"}${index === current ? " ✓" : ""}</span></button>`,
        )
        .join("")}
      <hr />
      <button class="row" role="menuitem" data-overview>${icon("squares-four")}All spaces<span class="meta">${isMac ? "⌥S" : "Alt+S"}</span></button>
      <button class="row" role="menuitem" data-new-space>${icon("plus")}New space</button>
    </div>`;
}

function showOverview() {
  layer.innerHTML = `
    <div class="overview" role="dialog" aria-label="All spaces">
      <button type="button" class="overview-close" data-close-layer aria-label="Close">${icon("x")}</button>
      <h3>${spaces.length} spaces</h3>
      <div class="overview-grid">
        ${spaces
          .map((item, index) => {
            const shown = item.tabs[item.active];
            return `
              <button class="overview-card ${index === current ? "current" : ""}" data-space="${index}">
                <span class="thumb">${pages[shown.page](shown)}</span>
                <span class="label"><span class="dot ${item.agent ? "ring" : ""}" style="--dot:${item.color}"></span>${escapeHtml(item.name)}<span class="meta">${item.tabs.length} ${item.tabs.length === 1 ? "tab" : "tabs"}</span></span>
              </button>`;
          })
          .join("")}
      </div>
    </div>`;
  say("Every space at a glance. Click one to jump in.");
}

const menuItems = [
  ["New tab", `${mod}T`, "new-tab"],
  ["Spaces", "", "spaces"],
  ["Command menu", `${mod}K`, "command"],
  null,
  ["Bookmarks", isMac ? "⌘⇧B" : "Ctrl+Shift+B", "tour:bookmarks"],
  ["History", isMac ? "⌘Y" : "Ctrl+H", "tour:history"],
  ["Downloads", isMac ? "⌘⇧J" : "Ctrl+Shift+J", "tour:downloads"],
  null,
  ["Split view", "", "tour:split"],
  ["Find in page", `${mod}F`, "tour:find"],
  ["Settings", `${mod},`, "tour:settings"],
];

function showMenu() {
  layer.innerHTML = `
    <div class="popover" style="top:82px;right:10px;width:250px" role="menu" aria-label="Browser menu">
      ${menuItems
        .map((item) =>
          item
            ? `<button class="row" role="menuitem" data-menu="${item[2]}">${item[0]}<span class="meta">${item[1]}</span></button>`
            : "<hr />",
        )
        .join("")}
    </div>`;
}

let paletteIndex = 0;
function paletteEntries(query) {
  const entries = [];
  spaces.forEach((item, spaceIndex) =>
    item.tabs.forEach((entry, tabIndex) =>
      entries.push({
        label: entry.title,
        meta: item.name,
        run: () => {
          current = spaceIndex;
          item.active = tabIndex;
          closeLayer();
          render();
        },
      }),
    ),
  );
  entries.push(
    { label: "New tab", meta: `${mod}T`, run: newTab },
    { label: "Show all spaces", meta: isMac ? "⌥S" : "Alt+S", run: showOverview },
    {
      label: currentTheme() === "dark" ? "Use light theme" : "Use dark theme",
      meta: "Theme",
      run: () => {
        setTheme(currentTheme() === "dark" ? "light" : "dark");
        closeLayer();
      },
    },
    { label: "Watch an agent book dinner", meta: "Agent", run: startAgent },
  );
  const words = query.trim().toLowerCase();
  return words
    ? entries.filter((entry) => `${entry.label} ${entry.meta}`.toLowerCase().includes(words))
    : entries;
}

function showPalette() {
  layer.innerHTML = `
    <div class="scrim" data-scrim></div>
    <div class="popover palette" role="dialog" aria-label="Command menu">
      <div class="palette-search">${icon("magnifying-glass")}<input data-palette-input placeholder="Search tabs and actions" aria-label="Search tabs and actions" /></div>
      <div class="palette-results" data-palette-results role="listbox"></div>
    </div>`;
  const input = $("[data-palette-input]");
  paletteIndex = 0;
  const draw = () => {
    const entries = paletteEntries(input.value);
    paletteIndex = Math.min(paletteIndex, Math.max(entries.length - 1, 0));
    $("[data-palette-results]").innerHTML = entries.length
      ? entries
          .map(
            (entry, index) =>
              `<button class="row ${index === paletteIndex ? "selected" : ""}" role="option" aria-selected="${index === paletteIndex}" data-entry="${index}">${escapeHtml(entry.label)}<span class="meta">${escapeHtml(entry.meta)}</span></button>`,
          )
          .join("")
      : `<div class="palette-empty">Nothing matches.</div>`;
    return entries;
  };
  let entries = draw();
  input.addEventListener("input", () => {
    paletteIndex = 0;
    entries = draw();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      paletteIndex = (paletteIndex + step + entries.length) % Math.max(entries.length, 1);
      entries = draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      entries[paletteIndex]?.run();
    }
  });
  $("[data-palette-results]").addEventListener("click", (event) => {
    const button = event.target.closest("[data-entry]");
    if (button) entries[Number(button.dataset.entry)]?.run();
  });
  input.focus({ preventScroll: true });
  say(`Type to find a tab in any space, or run an action. ${isMac ? "⌘K" : "Ctrl+K"} opens it in the app.`);
}

// The agent

class Interrupted extends Error {}

function check(run) {
  if (run !== agentRun || agent?.state !== "browsing") throw new Interrupted();
}
async function wait(ms, run) {
  await sleep(ms);
  check(run);
}

function bookingTab() {
  return agentSpace()?.tabs[0];
}

async function moveTo(selector, run) {
  if (!viewingAgent() || layer.innerHTML) {
    await wait(700, run);
    return;
  }
  const target = $(selector, mock);
  if (!target) {
    await wait(400, run);
    return;
  }
  const box = target.getBoundingClientRect();
  const origin = mock.getBoundingClientRect();
  const x = (box.left - origin.left + Math.min(box.width * 0.3, 60)) / scale - 4;
  const y = (box.top - origin.top + box.height * 0.6) / scale - 3;
  cursor.classList.add("on");
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  await wait(760, run);
}

async function press(run) {
  if (!cursor.classList.contains("on")) return;
  const base = cursor.style.transform.replace(/ scale\([^)]*\)/, "");
  cursor.classList.add("press");
  cursor.style.transform = `${base} scale(0.82)`;
  await sleep(120);
  cursor.style.transform = base;
  cursor.classList.remove("press");
  await wait(140, run);
}

function setField(key, value) {
  const item = bookingTab();
  item.form[key] = value;
  if (!viewingAgent()) return;
  const field = $(`[data-field="${key}"]`, mock);
  if (field) {
    field.value = value;
    $$(".field-focus", mock).forEach((element) => element.classList.remove("field-focus"));
    field.classList.add("field-focus");
  }
}

async function typeInto(key, text, run) {
  setField(key, "");
  for (const letter of text) {
    setField(key, bookingTab().form[key] + letter);
    await wait(40 + Math.random() * 60, run);
  }
}

function navigate(stage, path) {
  const item = bookingTab();
  item.stage = stage;
  item.path = path;
  item.title = { signin: "Sign in · Luca", confirmed: "Booked · Luca" }[stage] || "Reserve a table";
  if (viewingAgent()) render();
  else renderChrome();
}

const HANDOFF = 5;
const steps = [
  async (run) => {
    say("The agent opens a space of its own. Your tabs stay exactly where they were.");
    await wait(1200, run);
  },
  async (run) => {
    await moveTo('[data-field="name"]', run);
    await press(run);
    say("It reads the page, then fills the form one field at a time.");
    await typeInto("name", "Sam Rivera", run);
  },
  async (run) => {
    await moveTo('[data-field="party"]', run);
    await press(run);
    setField("party", "2 people");
    await wait(300, run);
  },
  async (run) => {
    await moveTo('[data-field="time"]', run);
    await press(run);
    setField("time", "Friday, 7:30 PM");
    await wait(300, run);
  },
  async (run) => {
    await moveTo('[data-field="submit"]', run);
    await press(run);
    navigate("signin", "/luca/sign-in");
    await wait(700, run);
  },
  async () => {
    agent.state = "needs-you";
    cursor.classList.remove("on");
    renderChrome();
    say("Luca wants a sign-in the agent doesn't have, so it hands the space to you and waits. Click Sign in on the page, then Let agent continue.");
  },
  async (run) => {
    if (!bookingTab().signedIn) {
      say("Still signed out, so the agent hands the space back to you. Click Sign in first.");
      await wait(600, run);
      agent.step = HANDOFF - 1;
      return;
    }
    say("You're signed in, and so is every space that shares your sign-ins. The agent picks up where it left off.");
    await moveTo('[data-field="confirm"]', run);
    await press(run);
    navigate("confirmed", "/luca/booked");
    await wait(500, run);
  },
  async () => {
    agent.state = "idle";
    cursor.classList.remove("on");
    renderChrome();
    say("Done. The agent goes idle, and the space stays open until you close it.");
  },
];

async function drive() {
  const run = ++agentRun;
  try {
    while (agent && agent.state === "browsing" && agent.step < steps.length) {
      await steps[agent.step](run);
      if (run !== agentRun) return;
      agent.step += 1;
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
  }
  if (run === agentRun && agent?.state === "browsing" && agent.step >= steps.length) {
    agent.state = "idle";
    renderChrome();
  }
}

function startAgent() {
  closeLayer();
  confirmingStop = false;
  if (agent && ["browsing", "in-control", "needs-you"].includes(agent.state)) {
    selectSpace(spaces.indexOf(agentSpace()));
    return;
  }
  spaces = spaces.filter((item) => !item.agent);
  spaces.push({
    id: "agent",
    name: "Dinner booking",
    color: "#8a79b5",
    agent: true,
    active: 0,
    tabs: [
      {
        title: "Reserve a table",
        host: "table.example",
        path: "/luca/reserve",
        page: "booking",
        icon: "#9a6b2f",
        stage: "form",
        signedIn: false,
        form: { name: "", party: "", time: "", email: "sam@example.com" },
      },
    ],
  });
  current = spaces.length - 1;
  agent = { state: "browsing", step: 0 };
  render();
  drive();
}

function takeOver() {
  if (!agent) return;
  agentRun += 1;
  agent.state = "in-control";
  cursor.classList.remove("on");
  renderChrome();
  say("You took over. The agent stops mid-step and waits. Let agent continue hands it back.");
}

function letContinue() {
  if (!agent) return;
  agent.state = "browsing";
  renderChrome();
  drive();
}

function stopAgent() {
  if (!confirmingStop) {
    confirmingStop = true;
    renderChrome();
    return;
  }
  confirmingStop = false;
  agentRun += 1;
  agent.state = "stopped";
  cursor.classList.remove("on");
  renderChrome();
  say("You stopped the agent in this space. Its tabs stay open, and only you can let an agent use it again. Press Watch an agent book dinner to start over.");
}

function stopAll() {
  confirmingStop = false;
  agentRun += 1;
  agent.state = "off";
  cursor.classList.remove("on");
  renderChrome();
  say("Every agent stopped and agent access is off. Press Watch an agent book dinner to start over.");
}

// Events inside the mock

mock.addEventListener("click", (event) => {
  const target = event.target.closest("button, [data-tab]");
  if (!target || !mock.contains(target)) {
    if (event.target.closest("[data-scrim]") || !event.target.closest(".popover, .overview")) closeLayer();
    return;
  }
  const data = target.dataset;
  if (data.close !== undefined) {
    event.stopPropagation();
    closeTab(Number(data.close));
  } else if (data.tab !== undefined) selectTab(Number(data.tab));
  else if (data.space !== undefined) selectSpace(Number(data.space));
  else if (data.overview !== undefined) showOverview();
  else if (data.closeLayer !== undefined) closeLayer();
  else if (data.newSpace !== undefined) {
    spaceCount += 1;
    spaces.splice(spaces.filter((item) => !item.agent).length, 0, {
      id: `space-${spaceCount}`,
      name: spaceCount === 3 ? "Side project" : `Space ${spaceCount}`,
      color: ["#c08a3e", "#4f9a94", "#b86f8a"][spaceCount % 3],
      active: 0,
      tabs: [{ title: "New tab", page: "newtab" }],
    });
    selectSpace(spaces.filter((item) => !item.agent).length - 1);
    say("A fresh space. It shares your sign-ins, unless you give it separate ones.");
  } else if (data.menu) {
    closeLayer();
    const [kind, name] = data.menu.split(":");
    if (kind === "tour") {
      showTourByKey(name);
      $("#tour").scrollIntoView();
    } else if (kind === "new-tab") newTab();
    else if (kind === "spaces") showSpaces();
    else if (kind === "command") showPalette();
  } else if (data.signin !== undefined) {
    bookingTab().signedIn = true;
    render();
    say(
      ["off", "stopped"].includes(agent?.state)
        ? "Signed in."
        : "Signed in. The agent was paused while you typed, and password fields stay hidden in its snapshots. Press Let agent continue.",
    );
  } else if (data.action) {
    const action = data.action;
    if (action === "spaces") layer.innerHTML ? closeLayer() : showSpaces();
    else if (action === "menu") layer.innerHTML ? closeLayer() : showMenu();
    else if (action === "new-tab") newTab();
    else if (action === "tab-search") showPalette();
    else if (action === "reload") renderPage(true);
    else if (action === "take-over") {
      if (confirmingStop) {
        confirmingStop = false;
        renderChrome();
      } else takeOver();
    } else if (action === "continue") letContinue();
    else if (action === "stop") stopAgent();
    else if (action === "stop-all") stopAll();
  }
});

mock.addEventListener("keydown", (event) => {
  const tabElement = event.target.closest("[data-tab]");
  if (tabElement && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectTab(Number(tabElement.dataset.tab));
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && layer.innerHTML) {
    closeLayer();
    return;
  }
  if (!demoVisible) return;
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if (primary && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showPalette();
  } else if (event.altKey && event.code === "KeyS" && !event.target.closest("input, textarea")) {
    event.preventDefault();
    showOverview();
  }
});

$(".try").addEventListener("click", (event) => {
  const button = event.target.closest("[data-try]");
  if (!button) return;
  const kind = button.dataset.try;
  if (kind === "agent") startAgent();
  else if (kind === "spaces") {
    showSpaces();
    say("Each space keeps its own tabs, and shares your sign-ins unless you say otherwise. Pick one, or open All spaces.");
  } else if (kind === "command") showPalette();
});

render();

// Terminal

const terminal = $("[data-terminal-body]");
// What book.mjs above prints when run, then a second script that takes the
// space back once the person has signed in.
const session = [
  ["cmd", "node kamapathy.mjs run book.mjs"],
  ["out", "space 8c1f2e04 shared"],
  ["out", "Reserve a table · Luca\nhttps://table.example/reserve\n\nControls:\n@e1 textbox \"Name\"\n@e2 spinbutton \"Party size\"\n@e3 textbox \"Time\"\n@e4 button \"Reserve\""],
  ["ok", "batch ok"],
  ["note", "Sign in needed. Space 8c1f2e04 is yours."],
  ["comment", "# You sign in, then say: go ahead"],
  ["cmd", "node kamapathy.mjs run - <<'EOF'"],
  ["cont", 'const dinner = await space("8c1f2e04");'],
  ["cont", "await dinner.resume();"],
  ["cont", "const [page] = await dinner.tabs();"],
  ["cont", 'await page.click("button.confirm");'],
  ["cont", "console.log(await page.text({ maxControls: 0 }));"],
  ["cont", "EOF"],
  ["out", "Booked · Luca\nhttps://table.example/booked\n\nYou're booked. Table for 2 at Luca, Friday 19:30."],
];
let terminalRun = 0;
terminal.addEventListener(
  "scroll",
  () => terminal.classList.toggle("scrolled", terminal.scrollTop > 4),
  { passive: true },
);
async function playTerminal() {
  const run = ++terminalRun;
  terminal.innerHTML = "";
  terminal.classList.remove("scrolled");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const [kind, text] of session) {
    if (run !== terminalRun) return;
    const line = document.createElement("div");
    terminal.append(line);
    if (kind === "cmd" || kind === "cont") {
      line.innerHTML = `<span class="prompt">${kind === "cmd" ? "$ " : "> "}</span><span class="cmd"></span><span class="caret"></span>`;
      const target = line.querySelector(".cmd");
      if (reduced) target.textContent = text;
      else
        for (const letter of text) {
          if (run !== terminalRun) return;
          target.textContent += letter;
          await sleep(kind === "cont" ? 6 + Math.random() * 10 : 14 + Math.random() * 26);
        }
      await sleep(reduced ? 0 : kind === "cont" ? 120 : 280);
      line.querySelector(".caret").remove();
    } else {
      line.className = kind;
      line.textContent = text;
      await sleep(reduced ? 0 : kind === "comment" ? 900 : 420);
    }
    terminal.scrollTop = terminal.scrollHeight;
  }
  const end = document.createElement("div");
  end.innerHTML = `<span class="prompt">$ </span><span class="caret"></span>`;
  terminal.append(end);
}
let terminalStarted = false;
new IntersectionObserver(
  ([entry]) => {
    if (entry.isIntersecting && !terminalStarted) {
      terminalStarted = true;
      playTerminal();
    }
  },
  { threshold: 0.35 },
).observe($("[data-terminal]"));
$("[data-replay]").addEventListener("click", playTerminal);

// Tour of real screenshots

const tour = [
  ["welcome", "First launch", "welcome", "The first launch brings over your bookmarks and history, then helps you sign in once. Every space and agent can use those sign-ins."],
  ["import", "Import", "import", "Settings imports bookmarks and history from Chrome, Edge, Brave, Arc, Vivaldi, Opera, Firefox or Safari, and never changes them."],
  ["space-options", "Space options", "space-options", "Any space can keep Separate sign-ins, when you create it or later from the Spaces popover."],
  ["agents", "Agents", "agent-browsing", "An agent at work: a green ring around its page and a bar to take over or stop it."],
  ["spaces", "Spaces", "spaces-grid", "All spaces side by side, sharing your sign-ins unless you say otherwise."],
  ["newtab", "New tab", "new-tab", "A quiet new tab with a search box and your shortcuts."],
  ["split", "Split view", "split-view", "Two live pages in one window."],
  ["command", "Command menu", "command-palette", "Find any tab or action from the keyboard."],
  ["menu", "Menu", "browser-menu", "Everything else lives in one small menu."],
  ["bookmarks", "Bookmarks", "bookmarks", "Bookmarks open as a dialog over a still frame of the page."],
  ["history", "History", "history", "History, searchable and grouped by day."],
  ["downloads", "Downloads", "downloads", "Downloads with progress, right where you left them."],
  ["find", "Find", "find", "Find in page sits at the page's top right."],
  ["settings", "Settings", "settings-agents", "Settings, including the one switch that turns agent access off."],
];
let tourIndex = 0;
const tourTabs = $("[data-tour-tabs]");
tourTabs.innerHTML = tour
  .map(
    ([key, label], index) =>
      `<button role="tab" type="button" data-tour="${index}" aria-selected="${index === 0}" id="tour-${key}">${label}</button>`,
  )
  .join("");
function showTour(index) {
  tourIndex = index;
  const [, label, file, text] = tour[index];
  const image = $("[data-tour-image]");
  image.src = `/images/${file}-${currentTheme()}.webp`;
  image.alt = text;
  $("[data-tour-caption]").textContent = text;
  for (const button of $$("button", tourTabs))
    button.setAttribute("aria-selected", String(Number(button.dataset.tour) === index));
  return label;
}
function showTourByKey(key) {
  const index = tour.findIndex(([name]) => name === key);
  if (index >= 0) showTour(index);
}
tourTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tour]");
  if (button) showTour(Number(button.dataset.tour));
});
tourTabs.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  const next = (tourIndex + (event.key === "ArrowRight" ? 1 : -1) + tour.length) % tour.length;
  showTour(next);
  $(`[data-tour="${next}"]`).focus();
});
showTour(0);

// Downloads

const assetPatterns = {
  "mac-arm64": /-mac-arm64\.dmg$/,
  "mac-x64": /-mac-x64\.dmg$/,
  "windows-setup": /-windows-x64-setup\.exe$/,
  "windows-portable": /-windows-x64-portable\.exe$/,
  "linux-appimage": /\.AppImage$/,
  "linux-deb": /\.deb$/,
  skill: /-skill-.*\.zip$/,
  checksums: /^SHA256SUMS\.txt$/,
};
const assetUrls = {};

async function macArchitecture() {
  try {
    const values = await navigator.userAgentData?.getHighEntropyValues?.(["architecture"]);
    if (values?.architecture) return values.architecture === "arm" ? "arm64" : "x64";
  } catch {}
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    if (/Apple M\d/i.test(renderer)) return "arm64";
    if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return "x64";
  } catch {}
  return null;
}

async function detectSystem() {
  const agentData = navigator.userAgentData;
  const platform = agentData?.platform || navigator.platform || "";
  const userAgent = navigator.userAgent;
  if (agentData?.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent)) return { os: "mobile" };
  if (/Mac/i.test(platform) && navigator.maxTouchPoints > 1) return { os: "mobile" };
  if (/Mac/i.test(platform) || /Mac OS X/.test(userAgent)) return { os: "mac", arch: await macArchitecture() };
  if (/Win/i.test(platform) || /Windows/.test(userAgent)) return { os: "windows" };
  if (/Linux|X11|CrOS/i.test(platform + userAgent)) return { os: "linux" };
  return { os: "other" };
}

async function fetchRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const releases = await response.json();
  return releases.find((release) => !release.draft && release.assets?.length) || null;
}

const installSteps = {
  mac: [
    "Open the downloaded <b>.dmg</b> and drag <b>Kamapathy</b> into <b>Applications</b>.",
    "Open Kamapathy. When macOS says it can't verify the app, click <b>Done</b>.",
    "In <b>System Settings</b>, open <b>Privacy &amp; Security</b> and click <b>Open Anyway</b>.",
  ],
  windows: [
    "Run the downloaded <b>setup .exe</b>.",
    "If SmartScreen appears, click <b>More info</b>, then <b>Run anyway</b>.",
    "Finish the setup. Kamapathy opens from the Start menu.",
  ],
  linux: [
    "Make the AppImage executable: <b>chmod +x</b> the file.",
    "Double-click it or run it from a terminal.",
    "Prefer a package? Install the <b>.deb</b> with <b>sudo apt install</b>.",
  ],
};

function thank(os, url) {
  const dialog = $("[data-thanks]");
  if (!dialog.showModal) return;
  const name = decodeURIComponent(url.split("/").pop());
  $("[data-thanks-file]").textContent = name.includes(".") ? name : "Your download is on its way.";
  $("[data-thanks-steps]").innerHTML = installSteps[os]
    ? `<ol>${installSteps[os].map((step) => `<li>${step}</li>`).join("")}</ol>`
    : "";
  $("[data-thanks-retry]").href = url;
  dialog.showModal();
}

function osForAsset(key) {
  return key.startsWith("mac") ? "mac" : key.startsWith("windows") ? "windows" : key.startsWith("linux") ? "linux" : null;
}

async function setUpDownloads() {
  const system = await detectSystem();
  const labels = { mac: "macOS", windows: "Windows", linux: "Linux" };
  const primaryKey = {
    mac: system.arch === "x64" ? "mac-x64" : "mac-arm64",
    windows: "windows-setup",
    linux: "linux-appimage",
  }[system.os];
  const primary = $("[data-primary]");
  const detail = $("[data-primary-detail]");
  const alternate = $("[data-alternate]");

  if (labels[system.os]) {
    $("[data-primary-label]").textContent = `Download for ${labels[system.os]}`;
    $(`[data-platform="${system.os}"]`).classList.add("detected");
    selectInstall(system.os);
    const iconName = { mac: "apple-logo", windows: "windows-logo", linux: "linux-logo" }[system.os];
    $("[data-os-icon] use").setAttribute("href", `#i-${iconName}`);
    detail.textContent = {
      mac: system.arch === "x64" ? "For Intel Macs" : "For Macs with Apple silicon",
      windows: "For Windows 10 and 11",
      linux: "AppImage for x64",
    }[system.os];
    if (system.os === "mac") {
      const other = system.arch === "x64" ? "mac-arm64" : "mac-x64";
      alternate.innerHTML = `<a href="${RELEASES}" data-asset="${other}">${system.arch === "x64" ? "Apple silicon Mac?" : "Intel Mac?"}</a>`;
    } else if (system.os === "linux") {
      alternate.innerHTML = `<a href="${RELEASES}" data-asset="linux-deb">Debian package</a>`;
    } else {
      alternate.innerHTML = `<a href="${RELEASES}" data-asset="windows-portable">Portable version</a>`;
    }
    primary.dataset.asset = primaryKey;
  } else if (system.os === "mobile") {
    $("[data-primary-label]").textContent = "See all downloads";
    primary.href = "#download";
    detail.textContent = "Kamapathy is a desktop browser for macOS, Windows and Linux.";
  }

  let release = null;
  try {
    release = await fetchRelease();
  } catch {}
  if (release) {
    for (const asset of release.assets)
      for (const [key, pattern] of Object.entries(assetPatterns))
        if (pattern.test(asset.name)) assetUrls[key] = asset.browser_download_url;
    const version = release.tag_name.replace(/^v/, "");
    $("[data-version-line]").innerHTML = `Version ${escapeHtml(version)}, released ${new Date(release.published_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}. <a href="${escapeHtml(release.html_url)}">Release notes</a>.`;
    if (labels[system.os]) detail.textContent += ` · Version ${version}`;
  }
  for (const link of $$("[data-asset]")) {
    const url = assetUrls[link.dataset.asset];
    if (url) link.href = url;
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-asset]");
  if (!link) return;
  const os = osForAsset(link.dataset.asset);
  if (os && assetUrls[link.dataset.asset]) setTimeout(() => thank(os, link.href), 300);
});

setUpDownloads();

// Install help and copy buttons

function selectInstall(os) {
  for (const button of $$("[data-install]"))
    button.setAttribute("aria-selected", String(button.dataset.install === os));
  for (const panel of $$("[data-install-panel]")) panel.hidden = panel.dataset.installPanel !== os;
}
$("[data-install-tabs]").addEventListener("click", (event) => {
  const button = event.target.closest("[data-install]");
  if (button) selectInstall(button.dataset.install);
});
selectInstall("mac");

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const text = button.previousElementSibling.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.innerHTML = icon("check");
    setTimeout(() => (button.innerHTML = icon("copy")), 1400);
  } catch {}
});
