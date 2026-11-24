// MinePanel UI. No framework, no build step. All text goes through textContent (no HTML injection).
const root = document.getElementById("app");
let timers = [];
let closers = [];
const cleanup = () => { timers.forEach(clearInterval); timers = []; closers.forEach((f) => f()); closers = []; };

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
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, path, body, raw) {
  const headers = { "X-Requested-With": "minepanel" };
  let payload = raw;
  if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") { location.hash = ""; start(); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

const fmtMb = (mb) => (mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const fmtBytes = (b) => (b == null ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtDur = (s) => { if (s == null) return "—"; const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m ${s % 60}s`; };
const STATUS_LABEL = { running: "Running", starting: "Starting…", stopping: "Stopping…", stopped: "Stopped", installing: "Downloading…", "install-failed": "Download failed", "needs-jar": "Needs server.jar" };
const pill = (status) => h("span", { class: `pill ${status}` }, h("i", { class: "dot" }), STATUS_LABEL[status] || status);

function sparkline(values, label, color) {
  if (values.length < 2) return h("div", { class: "spark-empty" }, "Collecting data…");
  const w = 240, hgt = 80, step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(hgt - Math.min(Math.max(v, 0), 100) / 100 * (hgt - 4) - 2).toFixed(1)}`);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "spark"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label);
  const area = document.createElementNS(ns, "polygon"); area.setAttribute("points", `0,${hgt} ${pts.join(" ")} ${w},${hgt}`); area.setAttribute("fill", color); area.setAttribute("fill-opacity", "0.15");
  const line = document.createElementNS(ns, "polyline"); line.setAttribute("points", pts.join(" ")); line.setAttribute("fill", "none"); line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2"); line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(area, line);
  return svg;
}

function modal(title, body) {
  const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) bg.remove(); } }, h("div", { class: "modal" }, h("h2", {}, title), body));
  document.body.append(bg);
  return bg;
}

// ---------- layout ----------
function shell(active, content) {
  cleanup();
  root.replaceChildren(h("div", { class: "shell" },
    h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "M"), "MinePanel"),
      h("nav", { class: "nav" },
        h("a", { href: "#/", class: active === "dash" ? "active" : "" }, "▦ Dashboard"),
        h("button", { onclick: async () => { await api("POST", "/api/logout", {}); start(); } }, "⏻ Log out"))),
    h("main", { class: "main" }, content)));
}

// ---------- auth ----------
function authView(setup) {
  cleanup();
  const err = h("div", { class: "banner err", style: "display:none" });
  const user = h("input", { type: "text", autocomplete: "username", autocapitalize: "off" });
  const pass = h("input", { type: "password", autocomplete: setup ? "new-password" : "current-password" });
  const submit = async (e) => {
    e.preventDefault(); err.style.display = "none";
    try { await api("POST", setup ? "/api/setup" : "/api/login", { username: user.value, password: pass.value }); start(); }
    catch (ex) { err.textContent = ex.message; err.style.display = ""; }
  };
  root.replaceChildren(h("div", { class: "auth" }, h("form", { class: "card", onsubmit: submit },
    h("div", { class: "brand", style: "margin-bottom:14px" }, h("span", { class: "brand-mark" }, "M"), "MinePanel"),
    h("p", { class: "sub", style: "margin-bottom:16px" }, setup ? "Welcome! Create the owner account. You'll use this to log in from any device on your Wi-Fi." : "Log in to manage your servers."),
    err,
    h("div", { class: "field" }, h("label", {}, "Username"), user),
    h("div", { class: "field" }, h("label", {}, setup ? "Password (at least 8 characters)" : "Password"), pass),
    h("button", { class: "btn primary", style: "width:100%", type: "submit" }, setup ? "Create account" : "Log in"))));
  user.focus();
}

// ---------- dashboard ----------
async function dashboardView() {
  const cpuHist = [], ramHist = [];
  const statsBox = h("div"), serversBox = h("div");
  shell("dash", [
    h("div", { class: "topbar" },
      h("div", {}, h("h1", {}, "Dashboard"), h("p", { class: "sub" }, "Your Minecraft servers, running on this device")),
      h("button", { class: "btn primary", onclick: () => createWizard() }, "＋ Create Server")),
    statsBox, serversBox]);

  async function refresh() {
    try {
      const [sys, sv] = await Promise.all([api("GET", "/api/system"), api("GET", "/api/servers")]);
      if (sys.cpuPercent != null) cpuHist.push(sys.cpuPercent); if (cpuHist.length > 60) cpuHist.shift();
      const usedPct = Math.round(100 * (1 - sys.ram.freeMb / sys.ram.totalMb)); ramHist.push(usedPct); if (ramHist.length > 60) ramHist.shift();
      const running = sv.servers.filter((s) => s.status === "running").length;
      const players = sv.servers.reduce((n, s) => n + s.playerCount, 0);
      statsBox.replaceChildren(
        !sys.java.found && h("div", { class: "banner err" }, "Java was not found on this device, so servers can't start. In Termux run: pkg install openjdk-21"),
        h("div", { class: "stats" },
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Servers running"), h("div", { class: "value" }, `${running} / ${sv.servers.length}`)),
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Players online"), h("div", { class: "value" }, players), h("div", { class: "hint" }, "from server join/leave logs")),
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Storage free"), h("div", { class: "value" }, sys.storage ? fmtMb(sys.storage.freeMb) : "—"), h("div", { class: "hint" }, sys.storage ? `of ${fmtMb(sys.storage.totalMb)}` : "")),
          h("div", { class: "card stat" }, h("div", { class: "label" }, "Device uptime"), h("div", { class: "value" }, fmtDur(sys.uptimeSec)), h("div", { class: "hint" }, `Java: ${sys.java.found ? (sys.java.version || "found") : "missing"}`))),
        h("div", { class: "grid-2" },
          h("div", { class: "card" }, h("div", { class: "chart-head" }, h("b", {}, "CPU"), h("span", {}, sys.cpuPercent == null ? "not available on this device" : `${sys.cpuPercent}% now`)), sparkline(cpuHist, "CPU usage", "#5b8cff")),
          h("div", { class: "card" }, h("div", { class: "chart-head" }, h("b", {}, "Memory"), h("span", {}, `${fmtMb(sys.ram.totalMb - sys.ram.freeMb)} of ${fmtMb(sys.ram.totalMb)}`)), sparkline(ramHist, "Memory usage", "#3ddc84"))));
      serversBox.replaceChildren(
        h("div", { class: "section-title" }, h("h2", {}, "Servers")),
        sv.servers.length === 0
          ? h("div", { class: "card empty" }, h("h3", {}, "No servers yet"), h("div", {}, "Press “Create Server” to make your first one."))
          : h("div", { class: "servers" }, sv.servers.map((s) => h("article", { class: "card server-card", onclick: () => { location.hash = `#/server/${s.id}/console`; } },
              h("div", { class: "head" }, h("h3", {}, s.name), pill(s.status)),
              h("div", { class: "meta" }, `${s.type === "custom" ? "Custom jar" : `${s.type === "paper" ? "Paper" : "Vanilla"} ${s.version}`} · port ${s.port} · ${s.playerCount} player${s.playerCount === 1 ? "" : "s"}`),
              s.status === "running" || s.status === "starting"
                ? h("div", { class: "bar-row" }, h("span", {}, "RAM"), h("div", { class: "bar" }, h("i", { style: `width:${Math.min(100, s.rssMb ? (s.rssMb / s.ramMb) * 100 : 0)}%` })), h("span", {}, `${s.rssMb ?? "?"} / ${s.ramMb} MB`))
                : h("div", { class: "meta" }, s.error || `RAM limit ${s.ramMb} MB`),
              s.status === "running" && h("div", { class: "meta" }, `Uptime ${fmtDur(s.uptimeSec)}`)))));
    } catch (e) { statsBox.replaceChildren(h("div", { class: "banner err" }, e.message)); }
  }
  await refresh();
  timers.push(setInterval(refresh, 3000));
}

async function createWizard() {
  const err = h("div", { class: "banner err", style: "display:none" });
  const name = h("input", { type: "text", maxlength: 40, placeholder: "My Survival World" });
  const type = h("select", {}, h("option", { value: "paper" }, "Paper (recommended, supports plugins)"), h("option", { value: "vanilla" }, "Vanilla (official Minecraft)"), h("option", { value: "custom" }, "I already have a server.jar / existing server"));
  const verBox = h("div");
  const ram = h("input", { type: "number", value: 1024, min: 256, step: 128 });
  const port = h("input", { type: "number", value: 25565, min: 1024, max: 65535 });
  const eula = h("input", { type: "checkbox" });
  let verEl = h("select", {});
  async function loadVersions() {
    verBox.replaceChildren();
    if (type.value === "custom") { verBox.append(h("div", { class: "hint" }, "After creating, open the Files tab and upload your server.jar (and any world/plugins).")); return; }
    verBox.append(h("div", { class: "hint" }, "Loading versions…"));
    try {
      const { versions } = await api("GET", `/api/versions?type=${type.value}`);
      verEl = h("select", {}, versions.map((v) => h("option", { value: v }, v)));
      verBox.replaceChildren(h("div", { class: "field" }, h("label", {}, "Minecraft version"), verEl));
    } catch (e) {
      verEl = h("input", { type: "text", placeholder: "e.g. 1.21.4" });
      verBox.replaceChildren(h("div", { class: "banner err" }, `${e.message}. Is this device online? You can type a version instead.`), h("div", { class: "field" }, h("label", {}, "Minecraft version"), verEl));
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
    h("label", { class: "check field" }, eula, h("span", {}, "I accept the ", h("a", { href: "https://www.minecraft.net/en-us/eula", target: "_blank", rel: "noopener" }, "Minecraft EULA"))),
    h("div", { class: "actions" }, create, h("button", { class: "btn", onclick: () => m.remove() }, "Cancel"))));
  loadVersions();
}

// ---------- server page ----------
async function serverView(id, tab) {
  let server;
  try { server = (await api("GET", `/api/servers/${id}`)).server; }
  catch (e) { shell("dash", h("div", { class: "banner err" }, e.message)); return; }

  const header = h("div"), body = h("div");
  shell("dash", [header, body]);

  const act = async (a) => { try { await api("POST", `/api/servers/${id}/${a}`, {}); } catch (e) { alert(e.message); } await refreshHeader(); };
  async function refreshHeader() {
    try { server = (await api("GET", `/api/servers/${id}`)).server; } catch { return; }
    const active = ["starting", "running", "stopping"].includes(server.status);
    header.replaceChildren(
      h("div", { class: "topbar" },
        h("div", {}, h("h1", {}, server.name), h("p", { class: "sub" }, `${server.type === "custom" ? "Custom jar" : `${server.type} ${server.version}`} · port ${server.port} · ${server.ramMb} MB`)),
        h("div", { class: "actions" }, pill(server.status),
          h("button", { class: "btn primary", disabled: active || server.status === "installing", onclick: () => act("start") }, "Start"),
          h("button", { class: "btn", disabled: server.status !== "running" && server.status !== "starting", onclick: () => act("stop") }, "Stop"),
          h("button", { class: "btn", disabled: server.status !== "running", onclick: () => act("restart") }, "Restart"),
          h("button", { class: "btn danger", disabled: !active, onclick: () => { if (confirm("Force kill can corrupt the world. Use only if Stop does not work. Kill now?")) act("kill"); } }, "Kill"))),
      server.error && h("div", { class: "banner err" }, server.error),
      server.status === "needs-jar" && h("div", { class: "banner" }, "No server.jar yet. Upload one in the Files tab."),
      h("div", { class: "tabs" }, ["console", "files", "properties", "settings"].map((t) => h("a", { href: `#/server/${id}/${t}`, class: t === tab ? "active" : "" }, t[0].toUpperCase() + t.slice(1)))),
      server.status === "running" && h("div", { class: "meta" }, `Players online: ${server.playerCount}${server.players.length ? " (" + server.players.join(", ") + ")" : ""} · Uptime ${fmtDur(server.uptimeSec)} · RAM ${server.rssMb ?? "?"} MB`));
  }
  await refreshHeader();
  timers.push(setInterval(refreshHeader, 2500));
  ({ console: consoleTab, files: filesTab, properties: propsTab, settings: settingsTab }[tab] || consoleTab)(id, body, () => server);
}

function consoleTab(id, body, getServer) {
  const log = h("div", { class: "console", role: "log" });
  const input = h("input", { type: "text", placeholder: "Type a command (e.g. op Steve, say hello, list)", autocomplete: "off", autocapitalize: "off" });
  const hk = `mp-hist-${id}`;
  let hist = []; try { hist = JSON.parse(localStorage.getItem(hk) || "[]"); } catch {}
  let hi = hist.length;
  const send = async (e) => {
    e.preventDefault();
    const c = input.value.trim(); if (!c) return;
    try { await api("POST", `/api/servers/${id}/command`, { command: c }); hist.push(c); hist = hist.slice(-50); hi = hist.length; try { localStorage.setItem(hk, JSON.stringify(hist)); } catch {} input.value = ""; }
    catch (ex) { add({ line: ex.message, kind: "sys" }); }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" && hist.length) { e.preventDefault(); hi = Math.max(0, hi - 1); input.value = hist[hi]; }
    else if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ""; }
  });
  function add(e) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.append(h("div", { class: e.kind }, e.line));
    while (log.childElementCount > 1500) log.firstChild.remove();
    if (near) log.scrollTop = log.scrollHeight;
  }
  const es = new EventSource(`/api/servers/${id}/logs`);
  es.onmessage = (m) => add(JSON.parse(m.data));
  closers.push(() => es.close());
  body.append(log, h("form", { class: "cmd-form", onsubmit: send }, input, h("button", { class: "btn primary", type: "submit" }, "Send")),
    h("div", { class: "hint", style: "color:var(--muted);font-size:12px;margin-top:6px" }, "Use ↑ / ↓ for command history. Commands only work while the server is running."));
  setTimeout(() => { log.scrollTop = log.scrollHeight; }, 100);
}

function filesTab(id, body) {
  let cur = "";
  const box = h("div");
  body.append(box);
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const q = (p) => encodeURIComponent(p);

  async function load(p) {
    cur = p;
    try {
      const { entries } = await api("GET", `/api/servers/${id}/files?path=${q(p)}`);
      const parts = p ? p.split("/") : [];
      const crumbs = h("div", { class: "crumbs" }, h("button", { onclick: () => load("") }, "server"),
        parts.map((part, i) => [" / ", h("button", { onclick: () => load(parts.slice(0, i + 1).join("/")) }, part)]));
      const fileInput = h("input", { type: "file", multiple: true, style: "display:none", onchange: async () => {
        for (const f of fileInput.files) {
          try { await api("PUT", `/api/servers/${id}/upload?path=${q(join(cur, f.name))}`, undefined, f); } catch (e) { alert(`${f.name}: ${e.message}`); }
        }
        load(cur);
      } });
      box.replaceChildren(crumbs,
        h("div", { class: "actions", style: "margin-bottom:12px" },
          h("button", { class: "btn small", onclick: () => fileInput.click() }, "⬆ Upload"), fileInput,
          h("button", { class: "btn small", onclick: async () => { const n = prompt("New file name"); if (n) { try { await api("PUT", `/api/servers/${id}/file`, { path: join(cur, n), content: "" }); load(cur); } catch (e) { alert(e.message); } } } }, "＋ File"),
          h("button", { class: "btn small", onclick: async () => { const n = prompt("New folder name"); if (n) { try { await api("POST", `/api/servers/${id}/mkdir`, { path: join(cur, n) }); load(cur); } catch (e) { alert(e.message); } } } }, "＋ Folder")),
        h("div", { class: "card", style: "padding:6px 10px;overflow-x:auto" }, h("table", { class: "files" },
          h("tr", {}, h("th", {}, "Name"), h("th", {}, "Size"), h("th", {})),
          entries.length === 0 && h("tr", {}, h("td", { colspan: 3, style: "color:var(--muted)" }, "Empty folder")),
          entries.map((en) => h("tr", {},
            h("td", {}, h("button", { class: "fname", onclick: () => (en.type === "dir" ? load(join(cur, en.name)) : edit(join(cur, en.name))) }, (en.type === "dir" ? "📁 " : "📄 ") + en.name)),
            h("td", { style: "color:var(--muted)" }, en.type === "dir" ? "" : fmtBytes(en.size)),
            h("td", { style: "text-align:right;white-space:nowrap" },
              en.type === "file" && h("a", { class: "btn small", href: `/api/servers/${id}/download?path=${q(join(cur, en.name))}` }, "Download"), " ",
              h("button", { class: "btn small", onclick: async () => { const n = prompt("Rename to", en.name); if (n && n !== en.name) { try { await api("POST", `/api/servers/${id}/rename`, { from: join(cur, en.name), to: join(cur, n) }); load(cur); } catch (e) { alert(e.message); } } } }, "Rename"), " ",
              h("button", { class: "btn small danger", onclick: async () => { if (confirm(`Delete ${en.name}? This cannot be undone.`)) { try { await api("POST", `/api/servers/${id}/delete`, { path: join(cur, en.name) }); load(cur); } catch (e) { alert(e.message); } } } }, "Delete")))))));
    } catch (e) { box.replaceChildren(h("div", { class: "banner err" }, e.message)); }
  }

  async function edit(p) {
    try {
      const { content } = await api("GET", `/api/servers/${id}/file?path=${q(p)}`);
      const ta = h("textarea", { class: "editor", spellcheck: "false" }); ta.value = content;
      const msg = h("span", { class: "sub" });
      box.replaceChildren(h("div", { class: "crumbs" }, h("b", {}, p)),
        ta, h("div", { class: "actions", style: "margin-top:10px" },
          h("button", { class: "btn primary", onclick: async () => { try { await api("PUT", `/api/servers/${id}/file`, { path: p, content: ta.value }); msg.textContent = "Saved. Restart the server to apply config changes."; } catch (e) { msg.textContent = e.message; } } }, "Save"),
          h("button", { class: "btn", onclick: () => load(cur) }, "Close"), msg));
    } catch (e) { alert(e.message); }
  }
  load("");
}

async function propsTab(id, body) {
  try {
    const { properties } = await api("GET", `/api/servers/${id}/properties`);
    if (!Object.keys(properties).length) { body.append(h("div", { class: "card empty" }, h("h3", {}, "No properties yet"), "Start the server once so Minecraft generates server.properties.")); return; }
    const inputs = {}, msg = h("span", { class: "sub" });
    const grid = h("div", { class: "props" }, Object.keys(properties).sort().map((k) => {
      inputs[k] = h("input", { type: "text", value: properties[k], disabled: k === "server-port" });
      return h("div", { class: "field" }, h("label", {}, k), inputs[k]);
    }));
    body.append(h("div", { class: "card" }, h("p", { class: "sub", style: "margin-top:0" }, "Changes take effect after the server restarts. The port is changed in Settings."), grid,
      h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: async () => {
        const changed = {}; for (const k in inputs) if (inputs[k].value !== properties[k] && k !== "server-port") changed[k] = inputs[k].value;
        if (!Object.keys(changed).length) { msg.textContent = "Nothing changed."; return; }
        try { await api("PUT", `/api/servers/${id}/properties`, { properties: changed }); Object.assign(properties, changed); msg.textContent = "Saved. Restart the server to apply."; } catch (e) { msg.textContent = e.message; }
      } }, "Save changes"), msg)));
  } catch (e) { body.append(h("div", { class: "banner err" }, e.message)); }
}

function settingsTab(id, body, getServer) {
  const s = getServer();
  const name = h("input", { type: "text", value: s.name }), ram = h("input", { type: "number", value: s.ramMb }), port = h("input", { type: "number", value: s.port });
  const msg = h("div", { class: "sub", style: "margin-top:10px" });
  body.append(h("div", { class: "card" },
    h("div", { class: "field" }, h("label", {}, "Name"), name),
    h("div", { class: "field" }, h("label", {}, "RAM limit (MB)"), ram, h("div", { class: "hint" }, "Stop the server to change RAM or port.")),
    h("div", { class: "field" }, h("label", {}, "Port"), port),
    h("button", { class: "btn primary", onclick: async () => { try { await api("PATCH", `/api/servers/${id}`, { name: name.value, ramMb: Number(ram.value), port: Number(port.value) }); msg.textContent = "Saved."; } catch (e) { msg.textContent = e.message; } } }, "Save"), msg),
    h("div", { class: "card", style: "margin-top:14px" }, h("h3", { style: "margin-top:0" }, "Delete server"),
      h("p", { class: "sub" }, "Permanently deletes this server and its world, plugins and files."),
      h("button", { class: "btn danger", onclick: async () => {
        if (prompt(`Type the server name (${s.name}) to confirm deletion`) !== s.name) return;
        try { await api("DELETE", `/api/servers/${id}`); location.hash = "#/"; } catch (e) { alert(e.message); }
      } }, "Delete server")));
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
    route();
  } catch (e) { root.replaceChildren(h("div", { class: "auth" }, h("div", { class: "card" }, "Cannot reach the panel: " + e.message))); }
}
start();
