// Runs real Minecraft processes. Status is only "running" after the server prints its "Done" line.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG = 2000;

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

export class ProcessManager {
  constructor({ java, serversDir }) {
    this.java = java;
    this.serversDir = serversDir;
    this.recs = new Map();
  }

  rec(id) {
    let r = this.recs.get(id);
    if (!r) {
      r = { status: "stopped", logs: [], seq: 0, subs: new Set(), players: new Set(), child: null, startedAt: null, lastError: null, restart: false, killTimer: null, buf: "", server: null };
      this.recs.set(id, r);
    }
    return r;
  }

  push(r, line, kind = "out") {
    const e = { id: ++r.seq, t: Date.now(), line, kind };
    r.logs.push(e);
    if (r.logs.length > MAX_LOG) r.logs.shift();
    for (const sub of r.subs) sub(e);
  }

  status(id) { return this.recs.get(id)?.status || "stopped"; }
  isActive(id) { return ["starting", "running", "stopping"].includes(this.status(id)); }

  async start(server) {
    const r = this.rec(server.id);
    if (this.isActive(server.id)) return { ok: false, error: "Server is already running" };
    const dir = path.join(this.serversDir, server.id);
    if (!fs.existsSync(path.join(dir, "server.jar"))) return { ok: false, error: "No server.jar found. Upload one in Files." };
    if (!(await portFree(server.port))) return { ok: false, error: `Port ${server.port} is already in use` };

    r.server = server; r.lastError = null; r.players.clear(); r.buf = "";
    r.status = "starting"; r.startedAt = Date.now();
    this.push(r, `--- starting ${server.name} (${server.ramMb} MB) ---`, "sys");

    const args = [`-Xmx${server.ramMb}M`, `-Xms${Math.min(256, server.ramMb)}M`, "-jar", "server.jar", "nogui"];
    let child;
    try {
      child = spawn(this.java, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      r.status = "stopped"; r.lastError = e.message;
      return { ok: false, error: e.message };
    }
    r.child = child;

    const onData = (chunk) => {
      r.buf += chunk.toString("utf8");
      let i;
      while ((i = r.buf.indexOf("\n")) >= 0) {
        const line = r.buf.slice(0, i).replace(/\r$/, "").replace(ANSI, "");
        r.buf = r.buf.slice(i + 1);
        this.handleLine(r, line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => {});

    child.on("error", (err) => {
      r.lastError = err.code === "ENOENT" ? `Java not found ("${this.java}"). Install it: pkg install openjdk-21` : err.message;
      this.push(r, `--- ${r.lastError} ---`, "sys");
      r.status = "stopped"; r.child = null;
    });

    child.on("exit", (code, signal) => {
      clearTimeout(r.killTimer);
      const wanted = r.status === "stopping";
      if (!wanted && !r.lastError) r.lastError = `Process exited unexpectedly (code ${code ?? signal})`;
      this.push(r, `--- server stopped (code ${code ?? signal}) ---`, "sys");
      r.status = "stopped"; r.child = null; r.players.clear(); r.startedAt = null;
      const again = r.restart; r.restart = false;
      if (again && r.server) this.start(r.server);
    });
    return { ok: true };
  }

  handleLine(r, line) {
    this.push(r, line);
    if (r.status === "starting" && /Done \([0-9.,]+s\)! For help/.test(line)) r.status = "running";
    let m;
    if ((m = line.match(/: ([A-Za-z0-9_]{1,16}) joined the game/))) r.players.add(m[1]);
    else if ((m = line.match(/: ([A-Za-z0-9_]{1,16}) left the game/))) r.players.delete(m[1]);
  }

  stop(id) {
    const r = this.recs.get(id);
    if (!r || !r.child) return { ok: true };
    if (r.status === "stopping") return { ok: true };
    r.status = "stopping";
    this.push(r, "--- stopping ---", "sys");
    try { r.child.stdin.write("stop\n"); } catch {}
    r.killTimer = setTimeout(() => { if (r.child) { this.push(r, "--- did not stop in 45s, killing ---", "sys"); r.child.kill("SIGKILL"); } }, 45_000);
    return { ok: true };
  }

  restart(server) {
    const r = this.rec(server.id);
    if (!r.child) return this.start(server);
    r.restart = true; r.server = server;
    return this.stop(server.id);
  }

  kill(id) {
    const r = this.recs.get(id);
    if (r?.child) { r.status = "stopping"; r.child.kill("SIGKILL"); }
    return { ok: true };
  }

  command(id, cmd) {
    const r = this.recs.get(id);
    if (!r?.child || r.status === "stopping") return { ok: false, error: "Server is not running" };
    this.push(r, `> ${cmd}`, "cmd");
    r.child.stdin.write(cmd + "\n");
    return { ok: true };
  }

  info(id) {
    const r = this.recs.get(id);
    if (!r) return { status: "stopped", players: [], pid: null, startedAt: null, lastError: null, rssMb: null };
    let rssMb = null;
    if (r.child?.pid) {
      try {
        const m = fs.readFileSync(`/proc/${r.child.pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
        if (m) rssMb = Math.round(Number(m[1]) / 1024);
      } catch {}
    }
    return { status: r.status, players: [...r.players], pid: r.child?.pid ?? null, startedAt: r.startedAt, lastError: r.lastError, rssMb };
  }

  async shutdownAll() {
    const active = [...this.recs.entries()].filter(([, r]) => r.child);
    for (const [id] of active) this.stop(id);
    const end = Date.now() + 20_000;
    while (Date.now() < end && active.some(([, r]) => r.child)) await new Promise((r) => setTimeout(r, 200));
    for (const [, r] of active) if (r.child) r.child.kill("SIGKILL");
  }
}
