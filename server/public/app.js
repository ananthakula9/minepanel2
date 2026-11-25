// MinePanel UI. No framework, no build step.
// All dynamic text goes through textContent/createTextNode, so nothing a server prints can inject HTML.
const root = document.getElementById("app");
const VERSION = "0.4.0";
let timers = [];
let closers = [];

function cleanup() {
  timers.forEach(clearInterval); timers = [];
  closers.forEach((f) => { try { f(); } catch {} }); closers = [];
  document.querySelectorAll(".modal-bg").forEach((m) => m.remove());
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v; // CSSOM is allowed by our strict CSP; the style attribute is not
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
// replaceChildren that ignores null/false (so `cond && element` is safe)
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
};
function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return t.content.firstChild;
}

// Tie every <label> to the control after it, so tapping a label focuses the field and screen readers announce it.
let labelQueued = false, labelSeq = 0;
function linkLabels() {
  labelQueued = false;
  for (const l of document.querySelectorAll("label:not([for])")) {
    if (l.querySelector("input,select,textarea")) continue;
    const c = l.nextElementSibling;
    if (c && /^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName)) { if (!c.id) c.id = `f${++labelSeq}`; l.setAttribute("for", c.id); }
  }
}
new MutationObserver(() => { if (!labelQueued) { labelQueued = true; requestAnimationFrame(linkLabels); } }).observe(document.body, { childList: true, subtree: true });

// ---------- feedback ----------
const toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
document.body.append(toastBox);
function toast(msg, kind = "ok") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 4000);
}
let offlineEl = null;
function setOffline(on) {
  if (on && !offlineEl) { offlineEl = h("div", { class: "offline" }, "Can't reach the panel. Retrying…"); document.body.append(offlineEl); }
  else if (!on && offlineEl) { offlineEl.remove(); offlineEl = null; }
}

let relogging = false;
async function api(method, path, body, raw) {
  const headers = { "X-Requested-With": "minepanel" };
  let payload = raw;
  if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" }); }
  catch { setOffline(true); throw new Error("Can't reach the panel. Is Termux still running?"); }
  setOffline(false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login" && path !== "/api/setup" && !relogging) { relogging = true; location.hash = ""; start().finally(() => { relogging = false; }); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

const fmtMb = (mb) => (mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const fmtBytes = (b) => (b == null ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const fmtDur = (s) => { if (s == null) return "—"; const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m ${s % 60}s`; };
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const STATUS_LABEL = { running: "Running", starting: "Starting…", stopping: "Stopping…", stopped: "Stopped", installing: "Downloading…", "install-failed": "Download failed", "needs-jar": "Needs jar" };
const setPill = (el, status) => { el.className = `pill ${status}`; put(el, h("i", { class: "dot" }), STATUS_LABEL[status] || status); return el; };
const pill = (status) => setPill(h("span", {}), status);
const addrOf = (s) => `${location.hostname}:${s.port}`;
const isActive = (s) => ["starting", "running", "stopping"].includes(s.status);

async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast("Copied " + text); return; } } catch {}
  const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  toast(ok ? "Copied " + text : "Could not copy. Select the address and copy it manually.", ok ? "ok" : "err");
}

// ---------- charts ----------
function sparkline(values, { max = 100, color = "#5b8cff", label = "chart", empty = "No data yet" } = {}) {
  if (values.length < 2) return h("div", { class: "spark-empty" }, empty);
  const w = 300, hgt = 90, step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(hgt - (Math.min(Math.max(v, 0), max) / max) * (hgt - 6) - 3).toFixed(1)}`);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "spark"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label);
  const mk = (tag, a) => { const e = document.createElementNS(ns, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
  for (const f of [0.25, 0.5, 0.75]) svg.append(mk("line", { x1: 0, x2: w, y1: hgt * f, y2: hgt * f, stroke: "#223046", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
  svg.append(mk("polygon", { points: `0,${hgt} ${pts.join(" ")} ${w},${hgt}`, fill: color, "fill-opacity": "0.16" }));
  svg.append(mk("polyline", { points: pts.join(" "), fill: "none", stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
  return svg;
}

// ---------- dialogs ----------
function modal(title, body) {
  const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) bg.remove(); } }, h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, h("h2", {}, title), body));
  bg.addEventListener("keydown", (e) => { if (e.key === "Escape") bg.remove(); });
  document.body.append(bg);
  return bg;
}
// Runs cb once when the modal leaves the page (Cancel, Escape or click outside), then stops watching.
function onRemoved(m, cb) {
  const mo = new MutationObserver(() => { if (!m.isConnected) { mo.disconnect(); cb(); } });
  mo.observe(document.body, { childList: true });
}
function confirmBox(title, text, okLabel = "Confirm", danger = false) {
  return new Promise((resolve) => {
    const ok = h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => { resolve(true); m.remove(); } }, okLabel);
    const m = modal(title, h("div", {}, h("p", { class: "sub", style: "margin:0 0 16px" }, text), h("div", { class: "actions" }, ok, h("button", { class: "btn", onclick: () => m.remove() }, "Cancel"))));
    onRemoved(m, () => resolve(false)); // resolve(true) above runs first, so this is a no-op after OK
    ok.focus();
  });
}
function askText(title, label, initial = "", okLabel = "OK") {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value: initial, autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
    const form = h("form", { onsubmit: (e) => { e.preventDefault(); resolve(input.value); m.remove(); } },
      h("div", { class: "field" }, h("label", {}, label), input),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit" }, okLabel), h("button", { class: "btn", type: "button", onclick: () => m.remove() }, "Cancel")));
    const m = modal(title, form);
    onRemoved(m, () => resolve(null));
    input.focus(); input.select();
  });
}
function selectEl(options, value, attrs = {}) {
  const s = h("select", attrs, options.map((o) => h("option", { value: o }, o)));
  if (value != null) s.value = value;
  return s;
}

async function logout() { try { await api("POST", "/api/logout", {}); } catch {} start(); }

// ---------- layout ----------
const SERVER_TABS = [
  ["console", "Console", "terminal"], ["files", "Files", "folder"], ["players", "Players", "users"], ["plugins", "Plugins", "package"],
  ["backups", "Backups", "archive"], ["online", "Online", "globe"], ["properties", "Properties", "sliders"], ["settings", "Settings", "gear"],
];
function shell({ serverId, serverName, tab }, content) {
  cleanup();
  const nav = serverId
    ? [h("a", { href: "#/" }, icon("back"), h("span", {}, "Servers")),
       SERVER_TABS.map(([key, label, ic]) => h("a", { href: `#/server/${serverId}/${key}`, class: key === tab ? "active" : "", "aria-current": key === tab ? "page" : null }, icon(ic), h("span", {}, label)))]
    : h("a", { href: "#/", class: "active", "aria-current": "page" }, icon("grid"), h("span", {}, "Dashboard"));
  root.replaceChildren(h("div", { class: "shell" },
    h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "M"), "MinePanel"),
      serverId && h("div", { class: "side-label" }, "Server"),
      serverId && h("div", { class: "side-server" }, serverName || serverId),
      h("nav", { class: "nav", "aria-label": "Main" }, nav),
      h("div", { class: "side-foot" },
        h("nav", { class: "nav" }, h("button", { onclick: logout }, icon("logout"), h("span", {}, "Log out"))),
        h("div", { class: "ver" }, `MinePanel v${VERSION}`))),
    h("main", { class: "main" }, content)));
  root.querySelector(".nav a.active")?.scrollIntoView({ inline: "center", block: "nearest" }); // phone: keep the current tab visible
}

// ---------- auth ----------
function authView(setup) {
  cleanup();
  const err = h("div", { class: "banner err", style: "display:none", role: "alert" });
  const user = h("input", { type: "text", autocomplete: "username", autocapitalize: "off", "aria-label": "Username" });
  const pass = h("input", { type: "password", autocomplete: setup ? "new-password" : "current-password", "aria-label": "Password" });
  const btn = h("button", { class: "btn primary", style: "width:100%", type: "submit" }, setup ? "Create account" : "Log in");
  const submit = async (e) => {
    e.preventDefault(); err.style.display = "none"; btn.disabled = true;
    try { await api("POST", setup ? "/api/setup" : "/api/login", { username: user.value, password: pass.value }); location.hash = ""; await start(); }
    catch (ex) { err.textContent = ex.message; err.style.display = ""; btn.disabled = false; }
  };
  root.replaceChildren(h("div", { class: "auth" }, h("form", { class: "card", onsubmit: submit },
    h("div", { class: "brand", style: "margin-bottom:14px" }, h("span", { class: "brand-mark" }, "M"), "MinePanel"),
    h("p", { class: "sub", style: "margin-bottom:16px" }, setup ? "Welcome! Create the owner account. You'll use it to log in from any device on your Wi-Fi." : "Log in to manage your servers."),
    err,
    h("div", { class: "field" }, h("label", {}, "Username"), user),
    h("div", { class: "field" }, h("label", {}, setup ? "Password (at least 8 characters)" : "Password"), pass),
    btn)));
  user.focus();
}

// ---------- dashboard ----------
function makeServerCard(s) {
  const name = h("h3"), status = h("span"), meta = h("div", { class: "meta" }), addr = h("div", { class: "addr" }), bars = h("div"), foot = h("div", { class: "meta" });
  const go = () => { location.hash = `#/server/${s.id}/console`; };
  const el = h("article", { class: "card server-card", tabindex: "0", role: "link", "aria-label": `Open ${s.name}`, onclick: go, onkeydown: (e) => { if (e.key === "Enter") go(); } },
    h("div", { class: "head" }, name, status), meta, addr, bars, foot);
  const update = (s) => {
    name.textContent = s.name; setPill(status, s.status);
    meta.textContent = `${s.type === "custom" ? "Custom jar" : `${s.type === "paper" ? "Paper" : "Vanilla"} ${s.version}`} · ${s.playerCount} player${s.playerCount === 1 ? "" : "s"}`;
    addr.textContent = s.publicAddress ? `Public: ${s.publicAddress}` : addrOf(s);
    if (s.status === "running" || s.status === "starting") {
      const ramPct = Math.min(100, s.rssMb ? (s.rssMb / s.ramMb) * 100 : 0);
      put(bars,
        h("div", { class: "bar-row" }, h("span", {}, "CPU"), h("div", { class: "bar" }, h("i", { style: `width:${Math.min(100, s.cpu ?? 0)}%` })), h("span", {}, s.cpu == null ? "—" : `${s.cpu}%`)),
        h("div", { class: "bar-row" }, h("span", {}, "RAM"), h("div", { class: "bar" }, h("i", { style: `width:${ramPct}%` })), h("span", {}, `${s.rssMb ?? "?"} / ${s.ramMb} MB`)));
      foot.textContent = s.status === "running" ? `Uptime ${fmtDur(s.uptimeSec)}` : "";
    } else { put(bars); foot.textContent = s.error || `RAM limit ${s.ramMb} MB`; }
  };
  update(s);
  return { el, update };
}

async function dashboardView() {
  const cpuHist = [], ramHist = [];
  const statsBox = h("div"), serversBox = h("div");
  shell({}, [
    h("div", { class: "topbar" },
      h("div", {}, h("h1", {}, "Dashboard"), h("p", { class: "sub" }, "Your Minecraft servers, running on this device")),
      h("div", { class: "actions" },
        h("button", { class: "btn mobile-only", onclick: logout }, "Log out"),
        h("button", { class: "btn primary", onclick: () => createWizard() }, "＋ Create Server"))),
    statsBox, serversBox]);

  const cards = new Map();
  let listEl = null, emptyEl = null;
  async function refresh() {
    try {
      const [sys, sv] = await Promise.all([api("GET", "/api/system"), api("GET", "/api/servers")]);
      if (sys.cpuPercent != null) { cpuHist.push(sys.cpuPercent); if (cpuHist.length > 60) cpuHist.shift(); }
      const usedPct = Math.round(100 * (1 - sys.ram.freeMb / sys.ram.totalMb)); ramHist.push(usedPct); if (ramHist.length > 60) ramHist.shift();
      const running = sv.servers.filter((s) => s.status === "running").length;
      const players = sv.servers.reduce((n, s) => n + s.playerCount, 0);
      const usedRam = sys.ram.totalMb - sys.ram.freeMb;
      const bar = (label, pct, text) => h("div", { class: "bar-row" }, h("span", {}, label), h("div", { class: "bar" }, h("i", { style: `width:${Math.min(100, Math.max(0, pct))}%` })), h("span", {}, text));
      put(statsBox,
        !sys.java.found && h("div", { class: "banner err" }, "Java was not found on this device, so servers can't start. In Termux run: pkg install openjdk-21"),
        h("div", { class: "stats" },
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Servers running"), h("div", { class: "value" }, `${running} / ${sv.servers.length}`)),
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Players online"), h("div", { class: "value" }, players), h("div", { class: "hint" }, "from join/leave logs")),
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Storage free"), h("div", { class: "value" }, sys.storage ? fmtMb(sys.storage.freeMb) : "—"), h("div", { class: "hint" }, sys.storage ? `of ${fmtMb(sys.storage.totalMb)}` : "")),
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Device uptime"), h("div", { class: "value" }, fmtDur(sys.uptimeSec)), h("div", { class: "hint" }, `Panel up ${fmtDur(sys.panelUptimeSec)}`))),
        h("div", { class: "grid-2" },
          h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h3", {}, "Node"), h("span", { class: "pill running" }, h("i", { class: "dot" }), "Online")),
            h("div", { class: "meta", style: "margin-top:0" }, `${sys.hostname} · ${sys.platform} · ${sys.cpuCores ?? "?"} cores · ${sys.java.found ? (sys.java.version || "Java found") : "Java missing"}`),
            bar("CPU", sys.cpuPercent ?? 0, sys.cpuPercent == null ? "n/a" : `${sys.cpuPercent}%`),
            bar("RAM", (usedRam / sys.ram.totalMb) * 100, `${fmtMb(usedRam)} / ${fmtMb(sys.ram.totalMb)}`),
            sys.storage && bar("Disk", ((sys.storage.totalMb - sys.storage.freeMb) / sys.storage.totalMb) * 100, `${fmtMb(sys.storage.totalMb - sys.storage.freeMb)} / ${fmtMb(sys.storage.totalMb)}`)),
          h("div", { class: "card" },
            h("div", { class: "chart-head" }, h("b", {}, "Device CPU"), h("span", {}, sys.cpuPercent == null ? "not available" : `${sys.cpuPercent}% now`)), sparkline(cpuHist, { color: "#5b8cff", label: "Device CPU usage", empty: "Collecting data…" }),
            h("div", { class: "chart-head", style: "margin-top:12px" }, h("b", {}, "Device memory"), h("span", {}, `${usedRam > 0 ? Math.round((usedRam / sys.ram.totalMb) * 100) : 0}% used`)), sparkline(ramHist, { color: "#3ddc84", label: "Device memory usage", empty: "Collecting data…" }))));

      // server list: update cards in place so clicks are never lost to a re-render
      if (!listEl) {
        listEl = h("div", { class: "servers" });
        emptyEl = h("div", { class: "card empty" }, h("h3", {}, "No servers yet"), h("div", {}, "Press “Create Server” to make your first one."));
        put(serversBox, h("div", { class: "section-title" }, h("h2", {}, "Servers")), listEl, emptyEl);
      }
      const seen = new Set();
      for (const s of sv.servers) {
        seen.add(s.id);
        let c = cards.get(s.id);
        if (!c) { c = makeServerCard(s); cards.set(s.id, c); listEl.append(c.el); } else c.update(s);
      }
      for (const [sid, c] of cards) if (!seen.has(sid)) { c.el.remove(); cards.delete(sid); }
      emptyEl.style.display = sv.servers.length ? "none" : "";
    } catch (e) { put(statsBox, h("div", { class: "banner err" }, e.message)); }
  }
  await refresh();
  timers.push(setInterval(refresh, 3000));
}

async function createWizard() {
  const err = h("div", { class: "banner err", style: "display:none", role: "alert" });
  const name = h("input", { type: "text", maxlength: 40, placeholder: "My Survival World", "aria-label": "Server name" });
  const type = h("select", { "aria-label": "Software" }, h("option", { value: "paper" }, "Paper (recommended, supports plugins)"), h("option", { value: "vanilla" }, "Vanilla (official Minecraft)"), h("option", { value: "custom" }, "I already have a server.jar / existing server"));
  const verBox = h("div");
  const ram = h("input", { type: "number", value: 1024, min: 256, step: 128, "aria-label": "RAM limit" });
  const port = h("input", { type: "number", value: 25565, min: 1024, max: 65535, "aria-label": "Port" });
  const eula = h("input", { type: "checkbox", id: "eula" });
  let verEl = h("select", {});
  async function loadVersions() {
    if (type.value === "custom") { put(verBox, h("div", { class: "hint muted", style: "margin-bottom:14px" }, "After creating, open Files and upload your server.jar (and any world or plugins). If its name differs, pick it in Settings.")); return; }
    put(verBox, h("div", { class: "hint muted", style: "margin-bottom:14px" }, "Loading versions…"));
    try {
      const { versions } = await api("GET", `/api/versions?type=${type.value}`);
      verEl = h("select", { "aria-label": "Minecraft version" }, versions.map((v) => h("option", { value: v }, v)));
      put(verBox, h("div", { class: "field" }, h("label", {}, "Minecraft version"), verEl));
    } catch (e) {
      verEl = h("input", { type: "text", placeholder: "e.g. 1.21.4", "aria-label": "Minecraft version" });
      put(verBox, h("div", { class: "banner err" }, `${e.message}. Is this device online? You can type a version instead.`), h("div", { class: "field" }, h("label", {}, "Minecraft version"), verEl));
    }
  }
  type.addEventListener("change", loadVersions);
  try { const { suggestedPort } = await api("GET", "/api/servers"); port.value = suggestedPort; } catch {}
  const create = h("button", { class: "btn primary", onclick: async () => {
    err.style.display = "none"; create.disabled = true;
    try {
      const { server } = await api("POST", "/api/servers", { name: name.value, type: type.value, version: type.value === "custom" ? undefined : verEl.value, ramMb: Number(ram.value), port: Number(port.value), eulaAccepted: eula.checked });
      m.remove(); location.hash = `#/server/${server.id}/console`;
    } catch (e) { err.textContent = e.message; err.style.display = ""; create.disabled = false; }
  } }, "Create server");
  const m = modal("Create server", h("div", {},
    err,
    h("div", { class: "field" }, h("label", {}, "Server name"), name),
    h("div", { class: "field" }, h("label", {}, "Software"), type),
    verBox,
    h("div", { class: "field" }, h("label", {}, "RAM limit (MB)"), ram, h("div", { class: "hint" }, "Keep this well below your phone's free RAM.")),
    h("div", { class: "field" }, h("label", {}, "Port"), port, h("div", { class: "hint" }, "Each server needs its own port. Players connect to your-phone-ip:port.")),
    h("label", { class: "check field", for: "eula" }, eula, h("span", {}, "I accept the ", h("a", { href: "https://www.minecraft.net/en-us/eula", target: "_blank", rel: "noopener" }, "Minecraft EULA"))),
    h("div", { class: "actions" }, create, h("button", { class: "btn", onclick: () => m.remove() }, "Cancel"))));
  name.focus();
  loadVersions();
}

// ---------- server page ----------
async function serverView(id, tab) {
  let server;
  try { server = (await api("GET", `/api/servers/${id}`)).server; }
  catch (e) { shell({}, h("div", { class: "banner err" }, e.message)); return; }
  if (!SERVER_TABS.some(([k]) => k === tab)) tab = "console";

  const header = h("div"), body = h("div");
  shell({ serverId: id, serverName: server.name, tab }, [header, body]);

  let sig = "";
  const power = async (btn, action) => {
    btn.disabled = true;
    try { await api("POST", `/api/servers/${id}/${action}`, {}); } catch (e) { toast(e.message, "err"); }
    await refreshHeader(true);
  };
  function buildHeader() {
    const active = isActive(server);
    const mk = (label, cls, enabled, action, confirm) => {
      const b = h("button", { class: `btn ${cls}`, disabled: !enabled, onclick: async () => {
        if (confirm && !(await confirmBox(confirm[0], confirm[1], confirm[2], true))) return;
        power(b, action);
      } }, label);
      return b;
    };
    put(header,
      h("div", { class: "srv-head" },
        h("div", {},
          h("h1", {}, server.name, pill(server.status)),
          h("p", { class: "sub" }, `${server.type === "custom" ? "Custom jar" : `${server.type} ${server.version}`} · ${server.publicAddress ? "Home Wi-Fi " : ""}`, h("span", { class: "addr" }, addrOf(server)),
            h("button", { class: "copy", onclick: () => copyText(addrOf(server)) }, "Copy")),
          server.publicAddress && h("p", { class: "sub" }, "Public (ngrok) ", h("span", { class: "addr" }, server.publicAddress),
            h("button", { class: "copy", onclick: () => copyText(server.publicAddress) }, "Copy"))),
        h("div", { class: "actions" },
          mk("Start", "primary", !active && server.status !== "installing" && !server.busy, "start"),
          mk("Restart", "", server.status === "running", "restart"),
          mk("Stop", "", server.status === "running" || server.status === "starting", "stop"),
          mk("Kill", "danger", active, "kill", ["Force kill?", "Killing can corrupt the world. Use it only if Stop does not work.", "Kill now"]))),
      server.error && h("div", { class: "banner err", role: "alert" }, server.error),
      server.status === "needs-jar" && h("div", { class: "banner" }, `${server.jarFile} was not found. Upload it in Files, or pick another jar in Settings.`),
      server.status === "installing" && h("div", { class: "banner info" }, "Downloading the server jar. This can take a minute."));
  }
  async function refreshHeader(force) {
    try { server = (await api("GET", `/api/servers/${id}`)).server; } catch { return; }
    // Rebuild only when something visible changed, so buttons are never replaced mid-click.
    const s = JSON.stringify([server.status, server.error, server.name, server.version, server.port, server.jarFile, server.busy, server.publicAddress]);
    if (force || s !== sig) { sig = s; buildHeader(); const sn = document.querySelector(".side-server"); if (sn) sn.textContent = server.name; }
  }
  await refreshHeader(true);
  timers.push(setInterval(refreshHeader, 2500));
  ({ console: consoleTab, files: filesTab, players: playersTab, plugins: pluginsTab, backups: backupsTab, online: onlineTab, properties: propsTab, settings: settingsTab }[tab])(id, body, () => server, refreshHeader);
}

function consoleTab(id, body, getServer) {
  const tile = (label) => { const v = h("div", { class: "value" }, "—"), hint = h("div", { class: "hint" }); return { el: h("div", { class: "card stat" }, h("div", { class: "label" }, label), v, hint), v, hint }; };
  const cpu = tile("CPU (of 1 core)"), mem = tile("Memory"), disk = tile("Disk"), players = tile("Players"), up = tile("Uptime");
  const cpuChart = h("div"), memChart = h("div"), cpuNow = h("span"), memNow = h("span");
  const log = h("div", { class: "console", role: "log", "aria-label": "Server console" });
  const input = h("input", { type: "text", placeholder: "Type a command (e.g. op Steve, say hello, list)", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Console command" });
  const hk = `mp-hist-${id}`;
  let hist = []; try { hist = JSON.parse(localStorage.getItem(hk) || "[]"); } catch {}
  let hi = hist.length;
  function add(e) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.append(h("div", { class: e.kind }, e.line));
    while (log.childElementCount > 1500) log.firstChild.remove();
    if (near) log.scrollTop = log.scrollHeight;
  }
  const send = async (e) => {
    e.preventDefault();
    const c = input.value.trim(); if (!c) return;
    try {
      await api("POST", `/api/servers/${id}/command`, { command: c });
      hist.push(c); hist = hist.slice(-50); hi = hist.length;
      try { localStorage.setItem(hk, JSON.stringify(hist)); } catch {}
      input.value = "";
    } catch (ex) { add({ line: ex.message, kind: "sys" }); }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && hist.length) { e.preventDefault(); hi = Math.max(0, hi - 1); input.value = hist[hi]; }
    else if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ""; }
  });
  const es = new EventSource(`/api/servers/${id}/logs`);
  es.onmessage = (m) => { try { add(JSON.parse(m.data)); } catch {} };
  closers.push(() => es.close());

  body.append(
    h("div", { class: "stats five" }, cpu.el, mem.el, disk.el, players.el, up.el),
    log,
    h("form", { class: "cmd-form", onsubmit: send }, input, h("button", { class: "btn primary", type: "submit" }, "Send")),
    h("div", { class: "hint muted", style: "font-size:12px;margin:6px 0 14px" }, "Use ↑ / ↓ for command history. Commands only work while the server is running."),
    h("div", { class: "grid-2" },
      h("div", { class: "card" }, h("div", { class: "chart-head" }, h("b", {}, "CPU"), cpuNow), cpuChart),
      h("div", { class: "card" }, h("div", { class: "chart-head" }, h("b", {}, "Memory"), memNow), memChart)));
  setTimeout(() => { log.scrollTop = log.scrollHeight; }, 150);

  async function poll() {
    try {
      const m = await api("GET", `/api/servers/${id}/metrics`);
      const running = m.status === "running" || m.status === "starting";
      cpu.v.textContent = running && m.cpu != null ? `${m.cpu}%` : "—";
      mem.v.textContent = running && m.ramMb != null ? `${m.ramMb} MB` : "—"; mem.hint.textContent = `limit ${m.ramLimitMb} MB`;
      disk.v.textContent = fmtMb(m.diskMb);
      players.v.textContent = running ? m.playerCount : "—"; players.hint.textContent = m.players.join(", ");
      up.v.textContent = running ? fmtDur(m.uptimeSec) : "—";
      const cpuVals = m.history.map((x) => x.cpu), memVals = m.history.map((x) => x.ramMb);
      const cpuMax = Math.max(100, Math.ceil(Math.max(0, ...cpuVals) / 100) * 100);
      cpuNow.textContent = running && m.cpu != null ? `${m.cpu}% now · scale 0–${cpuMax}%` : "not running";
      memNow.textContent = running && m.ramMb != null ? `${m.ramMb} MB now · limit ${m.ramLimitMb} MB` : "not running";
      put(cpuChart, sparkline(running ? cpuVals : [], { max: cpuMax, color: "#5b8cff", label: "Server CPU usage", empty: running ? "Collecting data…" : "Server is not running" }));
      put(memChart, sparkline(running ? memVals : [], { max: Math.max(m.ramLimitMb, ...memVals), color: "#3ddc84", label: "Server memory usage", empty: running ? "Collecting data…" : "Server is not running" }));
    } catch {}
  }
  poll();
  timers.push(setInterval(poll, 2000));
}

function filesTab(id, body) {
  let cur = "";
  const box = h("div");
  body.append(box);
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const q = encodeURIComponent;
  const tryDo = async (fn, ok) => { try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, "err"); } };

  async function load(p) {
    cur = p;
    try {
      const { entries } = await api("GET", `/api/servers/${id}/files?path=${q(p)}`);
      const parts = p ? p.split("/") : [];
      const crumbs = h("div", { class: "crumbs" }, h("button", { onclick: () => load("") }, "server"), parts.map((part, i) => [" / ", h("button", { onclick: () => load(parts.slice(0, i + 1).join("/")) }, part)]));
      const fileInput = h("input", { type: "file", multiple: true, style: "display:none", "aria-label": "Upload files", onchange: async () => {
        for (const f of fileInput.files) await tryDo(() => api("PUT", `/api/servers/${id}/upload?path=${q(join(cur, f.name))}`, undefined, f), `Uploaded ${f.name}`);
        load(cur);
      } });
      put(box, crumbs,
        h("div", { class: "actions", style: "margin-bottom:12px" },
          h("button", { class: "btn small", onclick: () => fileInput.click() }, "⬆ Upload"), fileInput,
          h("button", { class: "btn small", onclick: async () => { const n = await askText("New file", "File name", "", "Create"); if (n) { await tryDo(() => api("PUT", `/api/servers/${id}/file`, { path: join(cur, n), content: "" })); load(cur); } } }, "＋ File"),
          h("button", { class: "btn small", onclick: async () => { const n = await askText("New folder", "Folder name", "", "Create"); if (n) { await tryDo(() => api("POST", `/api/servers/${id}/mkdir`, { path: join(cur, n) })); load(cur); } } }, "＋ Folder")),
        h("div", { class: "card tbl-wrap", style: "padding:6px 10px" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Size"), h("th", {}))),
          h("tbody", {},
            entries.length === 0 && h("tr", {}, h("td", { colspan: 3, class: "muted" }, "Empty folder")),
            entries.map((en) => h("tr", {},
              h("td", {}, h("button", { class: "fname", onclick: () => (en.type === "dir" ? load(join(cur, en.name)) : edit(join(cur, en.name))) }, icon(en.type === "dir" ? "folder" : "file"), en.name)),
              h("td", { class: "muted" }, en.type === "dir" ? "" : fmtBytes(en.size)),
              h("td", { class: "right" },
                en.type === "file" && h("a", { class: "btn small", href: `/api/servers/${id}/download?path=${q(join(cur, en.name))}` }, "Download"), " ",
                h("button", { class: "btn small", onclick: async () => { const n = await askText("Rename", "New name", en.name, "Rename"); if (n && n !== en.name) { await tryDo(() => api("POST", `/api/servers/${id}/rename`, { from: join(cur, en.name), to: join(cur, n) })); load(cur); } } }, "Rename"), " ",
                h("button", { class: "btn small danger", onclick: async () => { if (await confirmBox(`Delete ${en.name}?`, en.type === "dir" ? "This deletes the folder and everything in it. It cannot be undone." : "This cannot be undone.", "Delete", true)) { await tryDo(() => api("POST", `/api/servers/${id}/delete`, { path: join(cur, en.name) })); load(cur); } } }, "Delete"))))))));
    } catch (e) { put(box, h("div", { class: "banner err" }, e.message)); }
  }

  async function edit(p) {
    try {
      const { content } = await api("GET", `/api/servers/${id}/file?path=${q(p)}`);
      const ta = h("textarea", { class: "editor", spellcheck: "false", "aria-label": `Editing ${p}` }); ta.value = content;
      put(box, h("div", { class: "crumbs" }, h("b", {}, p)), ta,
        h("div", { class: "actions", style: "margin-top:10px" },
          h("button", { class: "btn primary", onclick: () => tryDo(() => api("PUT", `/api/servers/${id}/file`, { path: p, content: ta.value }), "Saved. Restart the server to apply config changes.") }, "Save"),
          h("button", { class: "btn", onclick: () => load(cur) }, "Close")));
    } catch (e) { toast(e.message, "err"); }
  }
  load("");
}

function playersTab(id, body) {
  const lists = h("div", { style: "margin-top:14px" }), notice = h("div");
  const nameIn = h("input", { type: "text", placeholder: "Player name", maxlength: 16, autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "Player name" });
  let data = null, sig = "", bar = [];
  const act = async (action, name, reason) => {
    try { await api("POST", `/api/servers/${id}/player-action`, { action, name, reason }); toast("Sent to the server."); setTimeout(load, 900); }
    catch (e) { toast(e.message, "err"); }
  };
  const needName = (action) => () => { const n = nameIn.value.trim(); if (!n) { toast("Type a player name first.", "err"); nameIn.focus(); return; } act(action, n); };
  const btn = (label, cls, fn, extra = {}) => { const b = h("button", { class: `btn small ${cls}`, onclick: fn, ...extra }); b.textContent = label; bar.push(b); return b; };
  const row = (left, right) => h("div", { class: "list-row" }, h("div", {}, left), h("div", { class: "actions" }, right));

  const addForm = h("div", { class: "card" }, h("h3", {}, "Manage a player"),
    h("div", { class: "field" }, nameIn, h("div", { class: "hint" }, "Names are 1–16 letters, numbers or underscores. Spelling must match exactly.")),
    h("div", { class: "actions" }, btn("Make operator", "primary", needName("op")), btn("Remove operator", "", needName("deop")), btn("Add to whitelist", "", needName("whitelist-add")), btn("Remove from whitelist", "", needName("whitelist-remove")),
      btn("Ban", "danger", async () => { const n = nameIn.value.trim(); if (!n) { toast("Type a player name first.", "err"); return; } const why = await askText(`Ban ${n}`, "Reason (optional)", "", "Ban"); if (why !== null) act("ban", n, why); }),
      btn("Pardon", "", needName("pardon"))));
  body.append(notice, addForm, lists);

  function render() {
    bar.length = 0;
    const d = data;
    put(notice,
      !d.running && h("div", { class: "banner" }, "The server is not running. The lists below come from its files. Start it to make changes."),
      !d.onlineMode && h("div", { class: "banner info" }, "Online mode is off, so player names are not verified. Anyone on your network can join as any name, including an operator's. Only op people you trust."));
    for (const b of Array.from(addForm.querySelectorAll("button"))) b.disabled = !d.running;
    const empty = (t) => h("div", { class: "muted", style: "padding:6px 0" }, t);
    put(lists,
      h("div", { class: "card" }, h("h3", {}, `Online now (${d.online.length})`),
        d.online.length ? d.online.map((n) => row(h("b", {}, n), [h("button", { class: "btn small", disabled: !d.running, onclick: () => act("kick", n) }, "Kick"), h("button", { class: "btn small", disabled: !d.running, onclick: () => act("op", n) }, "Op"), h("button", { class: "btn small danger", disabled: !d.running, onclick: async () => { const why = await askText(`Ban ${n}`, "Reason (optional)", "", "Ban"); if (why !== null) act("ban", n, why); } }, "Ban")])) : empty(d.running ? "Nobody is online." : "Server is stopped.")),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, `Whitelist (${d.whitelist.length})`), h("div", { class: "actions" }, h("span", { class: "pill " + (d.whitelistEnabled ? "running" : "") }, h("i", { class: "dot" }), d.whitelistEnabled ? "Enabled" : "Disabled"), h("button", { class: "btn small", disabled: !d.running, onclick: () => act(d.whitelistEnabled ? "whitelist-off" : "whitelist-on") }, d.whitelistEnabled ? "Turn off" : "Turn on"))),
        d.whitelist.length ? d.whitelist.map((p) => row([h("b", {}, p.name), h("div", { class: "sub" }, p.uuid || "")], h("button", { class: "btn small", disabled: !d.running, onclick: () => act("whitelist-remove", p.name) }, "Remove"))) : empty("The whitelist is empty.")),
      h("div", { class: "card" }, h("h3", {}, `Operators (${d.ops.length})`),
        d.ops.length ? d.ops.map((p) => row([h("b", {}, p.name), h("div", { class: "sub" }, `Level ${p.level ?? "?"} · ${p.uuid || ""}`)], h("button", { class: "btn small", disabled: !d.running, onclick: () => act("deop", p.name) }, "Remove"))) : empty("No operators.")),
      h("div", { class: "card" }, h("h3", {}, `Banned (${d.banned.length})`),
        d.banned.length ? d.banned.map((p) => row([h("b", {}, p.name), h("div", { class: "sub" }, p.reason || "")], h("button", { class: "btn small", disabled: !d.running, onclick: () => act("pardon", p.name) }, "Pardon"))) : empty("Nobody is banned.")));
  }
  async function load() {
    try { data = await api("GET", `/api/servers/${id}/players`); } catch (e) { put(notice, h("div", { class: "banner err" }, e.message)); return; }
    const s = JSON.stringify(data);
    if (s === sig) return;
    sig = s; render();
  }
  load();
  timers.push(setInterval(load, 3000));
}

function pluginsTab(id, body) {
  const installed = h("div"), results = h("div"), notice = h("div");
  const q = encodeURIComponent;
  const search = h("input", { type: "search", placeholder: "Search Modrinth (e.g. EssentialsX, WorldEdit)", maxlength: 60, "aria-label": "Search plugins" });
  const fileInput = h("input", { type: "file", accept: ".jar", multiple: true, style: "display:none", "aria-label": "Upload plugin jar", onchange: async () => {
    for (const f of fileInput.files) {
      if (!/^[A-Za-z0-9._+() -]{1,120}\.jar$/.test(f.name)) { toast(`${f.name}: file name must end in .jar and use plain characters`, "err"); continue; }
      try { await api("PUT", `/api/servers/${id}/upload?path=${q("plugins/" + f.name)}`, undefined, f); toast(`Uploaded ${f.name}. Restart the server to load it.`); } catch (e) { toast(e.message, "err"); }
    }
    fileInput.value = ""; loadInstalled();
  } });
  let gameVersion = null;

  async function loadInstalled() {
    try {
      const d = await api("GET", `/api/servers/${id}/plugins`);
      gameVersion = d.gameVersion;
      put(notice, h("div", { class: "banner info" }, "Restart the server after adding, removing or disabling plugins. They are loaded only at startup."));
      put(installed, h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", {}, `Installed (${d.plugins.length})`), h("div", { class: "actions" }, h("button", { class: "btn small", onclick: () => fileInput.click() }, "⬆ Upload .jar"), fileInput)),
        d.plugins.length === 0 ? h("div", { class: "muted" }, "No plugins installed yet.") : h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, h("th", {}, "File"), h("th", {}, "Size"), h("th", {}, "State"), h("th", {}))),
          h("tbody", {}, d.plugins.map((p) => h("tr", {},
            h("td", {}, p.name.replace(/\.disabled$/, "")), h("td", { class: "muted" }, fmtBytes(p.size)),
            h("td", {}, h("span", { class: `pill ${p.enabled ? "running" : ""}` }, h("i", { class: "dot" }), p.enabled ? "Enabled" : "Disabled")),
            h("td", { class: "right" },
              h("button", { class: "btn small", onclick: async () => { try { await api("POST", `/api/servers/${id}/plugin-toggle`, { name: p.name }); toast(`${p.enabled ? "Disabled" : "Enabled"} ${p.name.replace(/\.disabled$/, "")}. Restart to apply.`); } catch (e) { toast(e.message, "err"); } loadInstalled(); } }, p.enabled ? "Disable" : "Enable"), " ",
              h("button", { class: "btn small danger", onclick: async () => { if (await confirmBox(`Remove ${p.name}?`, "The plugin file is deleted. Its settings folder is kept.", "Remove", true)) { try { await api("POST", `/api/servers/${id}/plugin-delete`, { name: p.name }); toast("Removed. Restart to apply."); } catch (e) { toast(e.message, "err"); } loadInstalled(); } } }, "Remove")))))))));
    } catch (e) { put(installed, h("div", { class: "banner err" }, e.message)); }
  }
  async function doSearch(e) {
    e.preventDefault();
    const term = search.value.trim();
    if (term.length < 2) { toast("Type at least 2 characters.", "err"); return; }
    put(results, h("div", { class: "muted" }, "Searching…"));
    try {
      const { results: hits } = await api("GET", `/api/servers/${id}/plugin-search?q=${q(term)}`);
      put(results,
        h("div", { class: "hint muted", style: "margin-bottom:6px;font-size:12px" }, gameVersion ? `Showing plugins that support Minecraft ${gameVersion}.` : "No Minecraft version is set for this server, so results are not filtered."),
        hits.length === 0 ? h("div", { class: "muted" }, "No plugins found.") : hits.map((p) => h("div", { class: "plugin-hit" },
          h("div", {}, h("b", {}, p.title), h("span", { class: "muted" }, ` by ${p.author} · ${fmtNum(p.downloads)} downloads`), h("div", { class: "sub" }, p.description)),
          (() => { const b = h("button", { class: "btn small primary", onclick: async () => {
            b.disabled = true; b.textContent = "Installing…";
            try {
              const r = await api("POST", `/api/servers/${id}/plugin-install`, { project: p.id });
              toast(`Installed ${r.filename}. Restart the server to load it.` + (r.requires?.length ? " It may also need other plugins (listed on its Modrinth page)." : ""));
              b.textContent = "Installed"; loadInstalled();
            } catch (ex) { toast(ex.message, "err"); b.disabled = false; b.textContent = "Install"; }
          } }, "Install"); return b; })())));
    } catch (ex) { put(results, h("div", { class: "banner err" }, ex.message)); }
  }
  body.append(notice, installed,
    h("div", { class: "card", style: "margin-top:14px" }, h("h3", {}, "Find plugins"),
      h("form", { class: "inline", onsubmit: doSearch, style: "margin-bottom:10px" }, search, h("button", { class: "btn primary", type: "submit" }, "Search")),
      h("div", { class: "hint muted", style: "font-size:12px;margin-bottom:8px" }, "Plugins come from Modrinth and are downloaded with a checksum check. Only install plugins you trust."),
      results));
  loadInstalled();
}

function onlineTab(id, body, getServer) {
  const box = h("div");
  const tokenIn = h("input", { type: "password", placeholder: "Paste your ngrok authtoken", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": "ngrok auth token" });
  body.append(box);
  let data = null, names = {}, onlineMode = true, sig = "";

  const act = async (fn, ok) => { try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, "err"); } await load(); };
  const stateLabel = { idle: ["", "Not connected"], starting: ["starting", "Connecting…"], online: ["running", "Online"], error: ["needs-jar", "Error"] };
  const mkPill = (state) => { const [cls, label] = stateLabel[state] || ["", state]; return h("span", { class: `pill ${cls}` }, h("i", { class: "dot" }), label); };
  const stepHead = (n, title, ok) => h("div", { class: "card-head" }, h("h3", {}, `${n}. ${title}`), h("span", { class: `pill ${ok ? "running" : "needs-jar"}` }, h("i", { class: "dot" }), ok ? "Done" : "To do"));

  function render() {
    const d = data, t = d.tunnel, srv = getServer();
    const active = t.state === "starting" || t.state === "online";
    const mine = t.serverId === id;
    const lan = addrOf(srv);
    const tokenBtn = h("button", { class: "btn primary", onclick: async () => {
      const v = tokenIn.value.trim();
      if (!v) { toast("Paste your auth token first.", "err"); tokenIn.focus(); return; }
      await act(async () => { await api("PUT", "/api/ngrok/settings", { authtoken: v }); tokenIn.value = ""; }, "Token saved.");
    }, disabled: active, title: active ? "Stop the tunnel first" : "" }, d.tokenSet ? "Replace token" : "Save token");

    put(box,
      h("div", { class: "card" }, h("h3", {}, "Let friends join from anywhere (ngrok)"),
        h("p", { class: "sub", style: "margin:0 0 8px" }, "ngrok gives this server a public address, so friends outside your home can join without any router settings. Traffic passes through ngrok's servers."),
        h("ul", { class: "muted", style: "margin:0;padding-left:18px;font-size:13px" },
          h("li", {}, "On the free plan, ngrok needs a credit or debit card on your account for TCP tunnels. It is not charged."),
          h("li", {}, "The public address changes every time you start the tunnel. Send friends the new one."),
          h("li", {}, "Free plans have a monthly data limit, and allow one tunnel at a time."))),
      !onlineMode && h("div", { class: "banner err", style: "margin-top:14px" },
        h("b", {}, "Online mode is OFF. "), "Once this server has a public address, anyone on the internet who finds it can join with any name, including an operator's name, and get operator powers. Turn online mode on before you start the tunnel (everyone then needs a real Minecraft account). ",
        h("button", { class: "btn small", style: "margin-top:8px", onclick: () => act(() => api("PUT", `/api/servers/${id}/properties`, { properties: { "online-mode": "true" } }), "Online mode turned on. Restart the server to apply.") }, "Turn on online mode")),

      h("div", { class: "card" }, stepHead(1, "Install ngrok on this phone", d.installed),
        d.installed
          ? h("div", {}, h("div", { class: "meta", style: "margin-top:0" }, `Found: ${d.binaryPath} (${d.version})`), h("button", { class: "btn small", onclick: () => load(true) }, "Re-check"))
          : h("div", {},
              h("p", { class: "sub", style: "margin:0 0 6px" }, "ngrok was not found. Install it once:"),
              h("ol", { style: "margin:0 0 8px;padding-left:20px;font-size:14px" },
                h("li", {}, "In your phone's browser open ", h("a", { href: "https://ngrok.com/download", target: "_blank", rel: "noopener" }, "ngrok.com/download"), ", choose Linux and ARM64, and download the file."),
                h("li", {}, "In Termux, unpack it and move it to your home folder (change the file name if yours differs):")),
              h("pre", { class: "code" }, "termux-setup-storage\ncd ~/storage/downloads\ntar -xzf ngrok-*.tgz\nmv ngrok ~/\nchmod +x ~/ngrok"),
              h("p", { class: "muted", style: "font-size:13px;margin:0 0 8px" }, "The panel looks for ngrok on your PATH and at ~/ngrok. Then press Re-check."),
              h("button", { class: "btn small", onclick: () => load(true) }, "Re-check"))),

      h("div", { class: "card" }, stepHead(2, "Add your ngrok auth token", d.tokenSet),
        h("p", { class: "sub", style: "margin:0 0 8px" }, "Sign up at ", h("a", { href: "https://dashboard.ngrok.com/signup", target: "_blank", rel: "noopener" }, "ngrok.com"), ", then copy your token from ", h("a", { href: "https://dashboard.ngrok.com/get-started/your-authtoken", target: "_blank", rel: "noopener" }, "dashboard.ngrok.com/get-started/your-authtoken"), "."),
        d.tokenSet && h("div", { class: "meta", style: "margin-top:0" }, `Token saved (ends in …${d.tokenHint}). It is stored only on this phone and is never shown again.`),
        h("div", { class: "inline" }, tokenIn, tokenBtn,
          d.tokenSet && h("button", { class: "btn danger", disabled: active, title: active ? "Stop the tunnel first" : "", onclick: async () => { if (await confirmBox("Remove the saved token?", "ngrok will stop working until you save a token again.", "Remove", true)) act(() => api("PUT", "/api/ngrok/settings", { authtoken: "" }), "Token removed."); } }, "Remove"))),

      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, "3. Start the tunnel"), mkPill(t.state === "idle" || mine || !active ? t.state : "idle")),
        active && !mine && h("div", { class: "banner info" }, `ngrok is currently connected to ${names[t.serverId] || "another server"}. Free plans allow one tunnel, so starting here will stop that one.`),
        srv.status !== "running" && h("div", { class: "banner" }, "This server is not running. Start it too, or players will not be able to join."),
        t.state === "online" && mine && h("div", { style: "margin-bottom:12px" },
          h("div", { class: "muted", style: "font-size:13px" }, "Friends join with this address (Minecraft → Multiplayer → Add Server):"),
          h("div", { class: "big-addr" }, t.address, h("button", { class: "copy", style: "font-size:13px", onclick: () => copyText(t.address) }, "Copy")),
          h("div", { class: "muted", style: "font-size:13px;margin-top:6px" }, `Your home Wi-Fi address is still ${lan}. The public address is now also shown at the top of this page.`)),
        t.state === "starting" && mine && h("div", { class: "muted", style: "margin-bottom:12px" }, "Connecting to ngrok… this usually takes a few seconds."),
        t.state === "error" && (mine || t.serverId == null || true) && h("div", { class: "banner err", role: "alert" }, h("b", {}, t.error), t.hint && h("div", { style: "margin-top:6px" }, t.hint)),
        h("div", { class: "actions" },
          h("button", { class: "btn primary", disabled: !d.installed || !d.tokenSet || (active && mine), title: !d.installed ? "Install ngrok first" : !d.tokenSet ? "Save your token first" : "", onclick: () => act(() => api("POST", "/api/ngrok/start", { serverId: id }), null) }, active && !mine ? "Switch tunnel to this server" : "Start tunnel"),
          h("button", { class: "btn", disabled: !active, onclick: () => act(() => api("POST", "/api/ngrok/stop", {}), "Tunnel stopped.") }, "Stop tunnel")),
        t.logs.length > 0 && h("details", { style: "margin-top:12px" }, h("summary", { class: "muted", style: "cursor:pointer;font-size:13px" }, "ngrok output (for troubleshooting)"),
          h("div", { class: "console", style: "height:auto;max-height:220px;margin-top:8px" }, t.logs.map((l) => h("div", {}, l))))),

      h("div", { class: "card" }, h("h3", {}, "Advanced"),
        h("label", { class: "check", for: "chroot" }, h("input", { type: "checkbox", id: "chroot", checked: d.useChroot, disabled: active, onchange: (e) => act(() => api("PUT", "/api/ngrok/settings", { useChroot: e.target.checked }), null) }), h("span", {}, "Run ngrok through termux-chroot")),
        h("div", { class: "hint muted", style: "font-size:12px;margin-top:6px" }, "Try this if the output shows a DNS error mentioning [::1]:53. First run in Termux: pkg install proot")));
  }

  async function load(refresh) {
    try {
      const [d, sv, pr] = await Promise.all([api("GET", `/api/ngrok${refresh === true ? "?refresh=1" : ""}`), api("GET", "/api/servers"), api("GET", `/api/servers/${id}/properties`)]);
      names = Object.fromEntries(sv.servers.map((x) => [x.id, x.name]));
      onlineMode = (pr.properties["online-mode"] ?? "true") === "true";
      const next = JSON.stringify([d, onlineMode, getServer().status, names[d.tunnel.serverId]]);
      if (next === sig && refresh !== true) return;
      if (document.activeElement === tokenIn) { data = d; return; } // never rebuild while the token is being typed
      data = d; sig = next; render();
    } catch (e) { put(box, h("div", { class: "banner err" }, e.message)); }
  }
  load();
  timers.push(setInterval(load, 2000));
}

function backupsTab(id, body, getServer, refreshHeader) {
  const box = h("div");
  body.append(box);
  const q = encodeURIComponent;
  let working = false;
  async function load() {
    try {
      const d = await api("GET", `/api/servers/${id}/backups`);
      const active = isActive(getServer());
      const create = h("button", { class: "btn primary", disabled: working || d.busy || d.backups.length >= d.max, onclick: async () => {
        working = true; create.disabled = true; create.textContent = "Creating… (big worlds take a while)";
        try { const r = await api("POST", `/api/servers/${id}/backup-create`, {}); toast(`Backup ${r.name} created.`); } catch (e) { toast(e.message, "err"); }
        working = false; load();
      } }, "Create backup");
      put(box,
        h("div", { class: "banner info" }, "Backups of a running server are safe: saving is paused for a moment while the archive is made. Restoring replaces everything in the server folder and needs the server stopped."),
        h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h3", {}, `Backups (${d.backups.length} of ${d.max})`), h("div", { class: "actions" }, d.freeMb != null && h("span", { class: "muted" }, `${fmtMb(d.freeMb)} free`), create)),
          d.backups.length === 0 ? h("div", { class: "muted" }, "No backups yet.") : h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
            h("thead", {}, h("tr", {}, h("th", {}, "Backup"), h("th", {}, "Size"), h("th", {}, "Created"), h("th", {}))),
            h("tbody", {}, d.backups.map((b) => h("tr", {},
              h("td", {}, b.name), h("td", { class: "muted" }, fmtBytes(b.size)), h("td", { class: "muted" }, new Date(b.mtime).toLocaleString()),
              h("td", { class: "right" },
                h("button", { class: "btn small", disabled: active || working, title: active ? "Stop the server first" : "", onclick: async () => {
                  if (!(await confirmBox("Restore this backup?", `Everything in the server folder is replaced with the contents of ${b.name}. Changes made since then are lost.`, "Restore", true))) return;
                  working = true; try { await api("POST", `/api/servers/${id}/backup-restore`, { name: b.name }); toast("Backup restored."); } catch (e) { toast(e.message, "err"); }
                  working = false; load(); refreshHeader(true);
                } }, "Restore"), " ",
                h("a", { class: "btn small", href: `/api/servers/${id}/backup-download?name=${q(b.name)}` }, "Download"), " ",
                h("button", { class: "btn small danger", onclick: async () => { if (await confirmBox("Delete this backup?", b.name, "Delete", true)) { try { await api("POST", `/api/servers/${id}/backup-delete`, { name: b.name }); } catch (e) { toast(e.message, "err"); } load(); } } }, "Delete")))))))));
    } catch (e) { put(box, h("div", { class: "banner err" }, e.message)); }
  }
  load();
  // Restore is only allowed while stopped, so refresh the buttons whenever the server starts or stops.
  let was = isActive(getServer());
  timers.push(setInterval(() => { const a = isActive(getServer()); if (a !== was) { was = a; if (!working) load(); } }, 1000));
}

async function propsTab(id, body) {
  try {
    const { properties } = await api("GET", `/api/servers/${id}/properties`);
    const keys = Object.keys(properties).sort();
    if (!keys.length) { body.append(h("div", { class: "card empty" }, h("h3", {}, "No properties yet"), "Start the server once so Minecraft generates server.properties.")); return; }
    const inputs = {};
    const filter = h("input", { type: "search", placeholder: "Filter properties…", "aria-label": "Filter properties" });
    const rows = keys.map((k) => {
      const isBool = properties[k] === "true" || properties[k] === "false";
      inputs[k] = isBool ? selectEl(["true", "false"], properties[k], { disabled: k === "server-port" }) : h("input", { type: "text", value: properties[k], disabled: k === "server-port" });
      return { k, el: h("div", { class: "field" }, h("label", {}, k), inputs[k]) };
    });
    filter.addEventListener("input", () => { const t = filter.value.trim().toLowerCase(); for (const r of rows) r.el.style.display = !t || r.k.includes(t) ? "" : "none"; });
    body.append(h("div", { class: "card" },
      h("p", { class: "sub", style: "margin-top:0" }, "Changes take effect after the server restarts. The port is changed in Settings."),
      h("div", { class: "field" }, filter), h("div", { class: "props" }, rows.map((r) => r.el)),
      h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: async () => {
        const changed = {}; for (const k in inputs) if (inputs[k].value !== properties[k] && k !== "server-port") changed[k] = inputs[k].value;
        if (!Object.keys(changed).length) { toast("Nothing changed."); return; }
        try { await api("PUT", `/api/servers/${id}/properties`, { properties: changed }); Object.assign(properties, changed); toast("Saved. Restart the server to apply."); } catch (e) { toast(e.message, "err"); }
      } }, "Save changes"))));
  } catch (e) { body.append(h("div", { class: "banner err" }, e.message)); }
}

async function settingsTab(id, body, getServer, refreshHeader) {
  const wrap = h("div");
  body.append(wrap);
  let was = isActive(getServer());
  const render = async () => {
  const s = getServer();
  const running = isActive(s);
  let jars = [s.jarFile];
  try { const { entries } = await api("GET", `/api/servers/${id}/files?path=`); jars = [...new Set([s.jarFile, ...entries.filter((e) => e.type === "file" && /^[A-Za-z0-9._-]{1,80}\.jar$/.test(e.name)).map((e) => e.name)])]; } catch {}
  const name = h("input", { type: "text", value: s.name, maxlength: 40, "aria-label": "Name" });
  const jar = selectEl(jars, s.jarFile, { disabled: running, "aria-label": "Server jar" });
  const ram = h("input", { type: "number", value: s.ramMb, min: 256, step: 128, disabled: running, "aria-label": "RAM limit" });
  const port = h("input", { type: "number", value: s.port, min: 1024, max: 65535, disabled: running, "aria-label": "Port" });
  const auto = h("input", { type: "checkbox", id: "autorestart", checked: s.autoRestart });
  put(wrap, h("div", { class: "card" }, h("h3", {}, "Server settings"),
    running && h("div", { class: "banner info" }, "Stop the server to change the jar, RAM or port."),
    h("div", { class: "field" }, h("label", {}, "Name"), name),
    h("div", { class: "field" }, h("label", {}, "Server jar"), jar, h("div", { class: "hint" }, "Which .jar in the server folder to run. Upload more in Files.")),
    h("div", { class: "field" }, h("label", {}, "RAM limit (MB)"), ram),
    h("div", { class: "field" }, h("label", {}, "Port"), port, h("div", { class: "hint" }, `Players connect to ${addrOf(s)}`)),
    h("label", { class: "check field", for: "autorestart" }, auto, h("span", {}, "Restart automatically if the server crashes (up to 3 times in 10 minutes)")),
    h("button", { class: "btn primary", onclick: async () => {
      const patch = { name: name.value, autoRestart: auto.checked };
      if (!running) Object.assign(patch, { ramMb: Number(ram.value), port: Number(port.value), jarFile: jar.value });
      try { await api("PATCH", `/api/servers/${id}`, patch); toast("Saved."); await refreshHeader(true); render(); } catch (e) { toast(e.message, "err"); }
    } }, "Save")),
    h("div", { class: "card" }, h("h3", {}, "Delete server"),
      h("p", { class: "sub", style: "margin-top:0" }, "Permanently deletes this server, its world, plugins, files and backups."),
      h("button", { class: "btn danger", disabled: running, title: running ? "Stop the server first" : "", onclick: async () => {
        const typed = await askText("Delete server", `Type the server name (${s.name}) to confirm`, "", "Delete");
        if (typed !== s.name) { if (typed !== null) toast("Name did not match. Nothing was deleted.", "err"); return; }
        try { await api("DELETE", `/api/servers/${id}`); location.hash = "#/"; } catch (e) { toast(e.message, "err"); }
      } }, "Delete server")));
  };
  await render();
  // Jar, RAM and port are locked while running, so redraw when the server starts or stops.
  timers.push(setInterval(() => { const a = isActive(getServer()); if (a !== was) { was = a; render(); } }, 1000));
}

// ---------- routing ----------
async function route() {
  const m = location.hash.match(/^#\/server\/([a-z0-9-]+)\/?([a-z]+)?/);
  if (m) return serverView(m[1], m[2] || "console");
  return dashboardView();
}
window.addEventListener("hashchange", route);

async function start() {
  try {
    const st = await api("GET", "/api/state");
    if (st.setupRequired) return authView(true);
    if (!st.user) return authView(false);
    await route();
  } catch (e) { cleanup(); root.replaceChildren(h("div", { class: "auth" }, h("div", { class: "card" }, "Cannot reach the panel: " + e.message))); }
}
start();
