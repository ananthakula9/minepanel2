import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Store } from "./lib/store.mjs";
import { hashPassword, verifyPassword, createSession, findSession, destroySession, LoginLimiter } from "./lib/auth.mjs";
import { ProcessManager } from "./lib/procs.mjs";
import * as files from "./lib/files.mjs";
import { PathError, validateServerId } from "./lib/paths.mjs";
import { listVersions, downloadJar, validVersion } from "./lib/jars.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC = { "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };
const TYPES = ["paper", "vanilla", "custom"];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createApp({ dataDir, java = "java", port = 8080, host = "0.0.0.0" }) {
  const store = new Store(dataDir);
  const serversDir = path.join(dataDir, "servers");
  fs.mkdirSync(serversDir, { recursive: true });
  const procs = new ProcessManager({ java, serversDir });
  const limiter = new LoginLimiter();
  const installs = new Map(); // serverId -> { state: "installing" | "failed", error? }

  const javaCheck = spawnSync(java, ["-version"], { encoding: "utf8" });
  const javaOk = !javaCheck.error;
  const javaVersion = javaOk ? ((javaCheck.stderr || javaCheck.stdout || "").split("\n")[0] || "").trim() : null;

  // --- system stats (CPU needs two samples, so we sample in the background) ---
  let cpuPct = null, lastCpu = null;
  const sampleCpu = () => {
    const cpus = os.cpus();
    if (!cpus.length) { cpuPct = null; return; }
    let idle = 0, total = 0;
    for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
    if (lastCpu && total > lastCpu.total) cpuPct = Math.round(100 * (1 - (idle - lastCpu.idle) / (total - lastCpu.total)));
    lastCpu = { idle, total };
  };
  sampleCpu();
  const cpuTimer = setInterval(sampleCpu, 2000); cpuTimer.unref();

  function systemInfo() {
    let storage = null;
    try { const s = fs.statfsSync(dataDir); storage = { totalMb: Math.round((s.blocks * s.bsize) / 1048576), freeMb: Math.round((s.bavail * s.bsize) / 1048576) }; } catch {}
    return {
      hostname: os.hostname(), platform: os.platform(), uptimeSec: Math.round(os.uptime()),
      cpuPercent: cpuPct, cpuCores: os.cpus().length || null,
      ram: { totalMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) },
      storage, java: { found: javaOk, version: javaVersion }, panelUptimeSec: Math.round(process.uptime()),
    };
  }

  // --- helpers ---
  const serverView = (s) => {
    const info = procs.info(s.id);
    const inst = installs.get(s.id);
    let status = info.status;
    let error = info.lastError;
    if (status === "stopped") {
      if (inst?.state === "installing") status = "installing";
      else if (inst?.state === "failed") { status = "install-failed"; error = inst.error; }
      else if (!fs.existsSync(path.join(serversDir, s.id, "server.jar"))) status = "needs-jar";
    }
    return {
      id: s.id, name: s.name, type: s.type, version: s.version, port: s.port, ramMb: s.ramMb, createdAt: s.createdAt,
      status, error, players: info.players, playerCount: info.players.length, pid: info.pid,
      uptimeSec: info.startedAt ? Math.round((Date.now() - info.startedAt) / 1000) : null, rssMb: info.rssMb,
    };
  };
  const getServer = (id) => {
    const s = store.data.servers.find((x) => x.id === id);
    if (!s) throw new HttpError(404, "Server not found");
    return s;
  };
  const rootOf = (s) => path.join(serversDir, s.id);
  const sendJson = (res, status, body) => {
    const b = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(b);
  };
  const readJson = async (req, limit = 1_000_000) => {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, "Request too large"); chunks.push(c); }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON"); }
  };
  const cookieToken = (req) => {
    const m = (req.headers.cookie || "").match(/(?:^|;\s*)mp_session=([0-9a-f]{64})/);
    return m ? m[1] : null;
  };
  const setCookie = (res, token, maxAge) => res.setHeader("Set-Cookie", `mp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
  const nextPort = () => {
    const used = new Set(store.data.servers.map((s) => s.port)); used.add(port);
    let p = 25565; while (used.has(p)) p++; return p;
  };
  const checkPort = (p, selfId) => {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new HttpError(400, "Port must be between 1024 and 65535");
    if (p === port) throw new HttpError(400, "That port is used by the panel itself");
    if (store.data.servers.some((s) => s.port === p && s.id !== selfId)) throw new HttpError(400, `Port ${p} is used by another server`);
  };
  const checkRam = (r) => {
    if (!Number.isInteger(r) || r < 256 || r > 65536) throw new HttpError(400, "RAM must be between 256 and 65536 MB");
  };
  const cleanName = (n) => {
    if (typeof n !== "string" || !n.trim() || n.length > 40 || /[\r\n\0]/.test(n)) throw new HttpError(400, "Name must be 1–40 characters");
    return n.trim();
  };
  const slug = (name) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "server";
    let id = base, i = 2;
    while (store.data.servers.some((s) => s.id === id)) id = `${base}-${i++}`;
    return id;
  };
  const pathParam = (url) => url.searchParams.get("path") ?? "";

  // --- routing ---
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const ip = req.socket.remoteAddress || "?";

    if (req.method === "GET" && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file)));
    }
    if (!p.startsWith("/api/")) throw new HttpError(404, "Not found");

    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (mutating && req.headers["x-requested-with"] !== "minepanel") throw new HttpError(403, "Missing request header");

    const token = cookieToken(req);
    const user = findSession(store, token);

    // Public endpoints
    if (p === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, { setupRequired: store.data.users.length === 0, user: user ? { username: user.username } : null });
    }
    if (p === "/api/setup" && req.method === "POST") {
      if (store.data.users.length) throw new HttpError(403, "Setup already completed");
      const b = await readJson(req);
      if (typeof b.username !== "string" || !/^[A-Za-z0-9_.-]{3,32}$/.test(b.username)) throw new HttpError(400, "Username: 3–32 letters, numbers, . _ -");
      if (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 200) throw new HttpError(400, "Password must be at least 8 characters");
      const u = { id: crypto.randomUUID(), username: b.username, password: hashPassword(b.password), role: "owner", createdAt: Date.now() };
      store.data.users.push(u); store.save();
      const s = createSession(store, u.id); setCookie(res, s.token, s.maxAgeSec);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/login" && req.method === "POST") {
      if (limiter.blocked(ip)) throw new HttpError(429, "Too many attempts. Wait a minute.");
      const b = await readJson(req);
      const u = store.data.users.find((x) => x.username === b.username);
      const good = u && typeof b.password === "string" && verifyPassword(b.password, u.password);
      if (!good) { limiter.fail(ip); throw new HttpError(401, "Wrong username or password"); }
      limiter.ok(ip);
      const s = createSession(store, u.id); setCookie(res, s.token, s.maxAgeSec);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/logout" && req.method === "POST") {
      destroySession(store, token); setCookie(res, "", 0);
      return sendJson(res, 200, { ok: true });
    }

    // Everything below requires a logged-in user.
    if (!user) throw new HttpError(401, "Not logged in");

    if (p === "/api/system" && req.method === "GET") return sendJson(res, 200, systemInfo());

    if (p === "/api/versions" && req.method === "GET") {
      const type = url.searchParams.get("type");
      if (!["paper", "vanilla"].includes(type)) throw new HttpError(400, "Unknown type");
      try { return sendJson(res, 200, { versions: await listVersions(type) }); }
      catch (e) { throw new HttpError(502, `Could not load versions: ${e.message}`); }
    }

    if (p === "/api/servers" && req.method === "GET") return sendJson(res, 200, { servers: store.data.servers.map(serverView), suggestedPort: nextPort() });

    if (p === "/api/servers" && req.method === "POST") {
      const b = await readJson(req);
      const name = cleanName(b.name);
      if (!TYPES.includes(b.type)) throw new HttpError(400, "Type must be paper, vanilla or custom");
      if (b.eulaAccepted !== true) throw new HttpError(400, "You must accept the Minecraft EULA");
      const ramMb = Number(b.ramMb), srvPort = Number(b.port);
      checkRam(ramMb); checkPort(srvPort);
      let version = "";
      if (b.type !== "custom") { if (!validVersion(b.version)) throw new HttpError(400, "Choose a Minecraft version"); version = b.version; }
      const id = slug(name);
      const server = { id, name, type: b.type, version, port: srvPort, ramMb, createdAt: Date.now() };
      const dir = rootOf(server);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "eula.txt"), "# Accepted by the panel owner when creating this server\neula=true\n");
      fs.writeFileSync(path.join(dir, "server.properties"), `server-port=${srvPort}\nmotd=${name.replace(/[\\=]/g, "")}\n`);
      store.data.servers.push(server); store.save();
      if (b.type !== "custom") {
        installs.set(id, { state: "installing" });
        downloadJar(b.type, version, path.join(dir, "server.jar"))
          .then(() => installs.delete(id))
          .catch((e) => installs.set(id, { state: "failed", error: `Download failed: ${e.message}` }));
      }
      return sendJson(res, 201, { server: serverView(server) });
    }

    const m = p.match(/^\/api\/servers\/([a-z0-9-]+)(?:\/([a-z]+))?$/);
    if (!m) throw new HttpError(404, "Not found");
    validateServerId(m[1]);
    const server = getServer(m[1]);
    const action = m[2];
    const root = rootOf(server);

    if (!action && req.method === "GET") return sendJson(res, 200, { server: serverView(server) });

    if (!action && req.method === "PATCH") {
      const b = await readJson(req);
      const running = procs.isActive(server.id);
      if (b.name !== undefined) server.name = cleanName(b.name);
      if (b.ramMb !== undefined) { if (running) throw new HttpError(409, "Stop the server to change RAM"); checkRam(Number(b.ramMb)); server.ramMb = Number(b.ramMb); }
      if (b.port !== undefined) {
        if (running) throw new HttpError(409, "Stop the server to change the port");
        checkPort(Number(b.port), server.id); server.port = Number(b.port);
        const pf = path.join(root, "server.properties");
        const cur = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : "";
        fs.writeFileSync(pf, files.updateProps(cur, { "server-port": String(server.port) }));
      }
      store.save();
      return sendJson(res, 200, { server: serverView(server) });
    }

    if (!action && req.method === "DELETE") {
      if (procs.isActive(server.id)) throw new HttpError(409, "Stop the server before deleting it");
      fs.rmSync(root, { recursive: true, force: true });
      store.data.servers = store.data.servers.filter((s) => s.id !== server.id); store.save();
      procs.recs.delete(server.id); installs.delete(server.id);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && ["start", "stop", "restart", "kill"].includes(action)) {
      if (installs.get(server.id)?.state === "installing") throw new HttpError(409, "Still downloading the server jar");
      let r;
      if (action === "start") r = await procs.start(server);
      else if (action === "stop") r = procs.stop(server.id);
      else if (action === "kill") r = procs.kill(server.id);
      else r = await procs.restart(server);
      if (!r.ok) throw new HttpError(409, r.error);
      return sendJson(res, 200, { server: serverView(server) });
    }

    if (action === "command" && req.method === "POST") {
      const b = await readJson(req);
      if (typeof b.command !== "string" || !b.command.trim() || b.command.length > 500) throw new HttpError(400, "Invalid command");
      const cmd = b.command.replace(/[\r\n\0]+/g, " ").replace(/^\//, "").trim();
      const r = procs.command(server.id, cmd);
      if (!r.ok) throw new HttpError(409, r.error);
      return sendJson(res, 200, { ok: true });
    }

    if (action === "logs" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      const rec = procs.rec(server.id);
      const send = (e) => res.write(`id: ${e.id}\ndata: ${JSON.stringify({ t: e.t, line: e.line, kind: e.kind })}\n\n`);
      for (const e of rec.logs) send(e);
      rec.subs.add(send);
      const ka = setInterval(() => res.write(": ka\n\n"), 15_000);
      req.on("close", () => { rec.subs.delete(send); clearInterval(ka); });
      return;
    }

    if (action === "files" && req.method === "GET") return sendJson(res, 200, { path: pathParam(url), entries: files.list(root, pathParam(url)) });
    if (action === "file" && req.method === "GET") return sendJson(res, 200, { content: files.readText(root, pathParam(url)) });
    if (action === "file" && req.method === "PUT") {
      const b = await readJson(req, 3_000_000); files.writeText(root, b.path, b.content);
      return sendJson(res, 200, { ok: true });
    }
    if (action === "mkdir" && req.method === "POST") { const b = await readJson(req); files.mkdir(root, b.path); return sendJson(res, 200, { ok: true }); }
    if (action === "rename" && req.method === "POST") { const b = await readJson(req); files.rename(root, b.from, b.to); return sendJson(res, 200, { ok: true }); }
    if (action === "delete" && req.method === "POST") { const b = await readJson(req); files.remove(root, b.path); return sendJson(res, 200, { ok: true }); }

    if (action === "download" && req.method === "GET") {
      const f = files.resolveForStream(root, pathParam(url));
      const st = fs.statSync(f);
      if (!st.isFile()) throw new HttpError(400, "Not a file");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size, "Content-Disposition": `attachment; filename="${path.basename(f).replace(/[^\w.\- ]/g, "_")}"` });
      return pipeline(fs.createReadStream(f), res);
    }

    if (action === "upload" && req.method === "PUT") {
      const f = files.resolveForStream(root, pathParam(url));
      if (f === fs.realpathSync(root) || (fs.existsSync(f) && fs.statSync(f).isDirectory())) throw new HttpError(400, "Invalid upload path");
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > files.MAX_UPLOAD_BYTES) throw new HttpError(413, "File too large (limit 300 MB)");
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + ".upload";
      let n = 0;
      req.on("data", (c) => { n += c.length; if (n > files.MAX_UPLOAD_BYTES) req.destroy(new Error("too large")); });
      try { await pipeline(req, fs.createWriteStream(tmp)); fs.renameSync(tmp, f); }
      catch { fs.rmSync(tmp, { force: true }); throw new HttpError(400, "Upload failed"); }
      return sendJson(res, 200, { ok: true });
    }

    if (action === "properties" && req.method === "GET") {
      const pf = path.join(root, "server.properties");
      return sendJson(res, 200, { properties: files.parseProps(fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : "") });
    }
    if (action === "properties" && req.method === "PUT") {
      const b = await readJson(req);
      const upd = {};
      for (const [k, v] of Object.entries(b.properties || {})) {
        if (!/^[a-z0-9.-]{1,64}$/.test(k)) throw new HttpError(400, `Invalid key: ${k}`);
        if (typeof v !== "string" || /[\r\n\0]/.test(v) || v.length > 500) throw new HttpError(400, `Invalid value for ${k}`);
        if (k === "server-port") continue; // managed in Settings so ports stay unique
        upd[k] = v;
      }
      const pf = path.join(root, "server.properties");
      fs.writeFileSync(pf, files.updateProps(fs.existsSync(pf) ? fs.readFileSync(pf, "utf8") : "", upd));
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, "Not found");
  }

  const httpServer = http.createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      if (e instanceof PathError) return sendJson(res, 400, { error: e.message });
      if (e?.code === "ENOENT") return sendJson(res, 404, { error: "File or folder not found" });
      console.error(e);
      sendJson(res, 500, { error: "Internal error" });
    });
  });

  return {
    httpServer, procs, store,
    listen: () => new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address().port))),
    close: async () => { await procs.shutdownAll(); clearInterval(cpuTimer); httpServer.closeAllConnections?.(); await new Promise((r) => httpServer.close(r)); },
  };
}
