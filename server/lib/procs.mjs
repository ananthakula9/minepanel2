// Runs real Minecraft processes. Status is only "running" after the server prints its "Done" line.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG = 2000;
const MAX_HIST = 90; // 90 samples x 2 s = 3 minutes
const CLK_TCK = 100; // Linux/Android standard
export const JAR_RE = /^[A-Za-z0-9._-]{1,80}\.jar$/;

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

function readRssMb(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}

export class ProcessManager {
  constructor({ java, serversDir, crashRestartDelayMs = 5000, sampleMs = 2000 }) {
    this.java = java;
    this.serversDir = serversDir;
    this.crashRestartDelayMs = crashRestartDelayMs;
    this.recs = new Map();
    this.sampler = setInterval(() => this.sample(), sampleMs);
    this.sampler.unref();
  }

  rec(id) {
    let r = this.recs.get(id);
    if (!r) {
      r = { status: "stopped", logs: [], seq: 0, subs: new Set(), players: new Set(), child: null, startedAt: null, lastError: null, restart: false, killTimer: null, restartTimer: null, crashes: [], buf: "", server: null, hist: [], cpu: null, lastTicks: null, lastT: null };
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

  // CPU is shown as % of ONE core (like `top`), so a busy 4-thread server can exceed 100.
  sample() {
    const now = Date.now();
    for (const r of this.recs.values()) {
      const pid = r.child?.pid;
      if (!pid) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ticks = Number(f[11]) + Number(f[12]);
        if (r.lastTicks != null && now > r.lastT) r.cpu = Math.max(0, Math.round(((ticks - r.lastTicks) / CLK_TCK / ((now - r.lastT) / 1000)) * 100));
        r.lastTicks = ticks; r.lastT = now;
      } catch { r.cpu = null; }
      r.hist.push({ t: now, cpu: r.cpu ?? 0, ramMb: readRssMb(pid) ?? 0 });
      if (r.hist.length > MAX_HIST) r.hist.shift();
    }
  }

  async start(server) {
    const r = this.rec(server.id);
    clearTimeout(r.restartTimer);
    if (this.isActive(server.id)) return { ok: false, error: "Server is already running" };
    const jar = server.jarFile || "server.jar";
    if (!JAR_RE.test(jar)) return { ok: false, error: "Invalid jar file name" };
    const dir = path.join(this.serversDir, server.id);
    if (!fs.existsSync(path.join(dir, jar))) return { ok: false, error: `No ${jar} found. Upload one in Files.` };
    if (!(await portFree(server.port))) return { ok: false, error: `Port ${server.port} is already in use` };
    if (this.isActive(server.id)) return { ok: false, error: "Server is already running" };

    r.server = server; r.lastError = null; r.players.clear(); r.buf = "";
    r.hist = []; r.cpu = null; r.lastTicks = null; r.lastT = null;
    r.status = "starting"; r.startedAt = Date.now();
    this.push(r, `--- starting ${server.name} (${server.ramMb} MB) ---`, "sys");

    const args = [`-Xmx${server.ramMb}M`, `-Xms${Math.min(256, server.ramMb)}M`, "-jar", jar, "nogui"];
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
      if (r.child !== child) return; // stale event from an older process
      clearTimeout(r.killTimer);
      const wanted = r.status === "stopping";
      const crashed = !wanted && !r.lastError;
      if (crashed) r.lastError = `Process exited unexpectedly (code ${code ?? signal})`;
      this.push(r, `--- server stopped (code ${code ?? signal}) ---`, "sys");
      r.status = "stopped"; r.child = null; r.players.clear(); r.startedAt = null;
      const again = r.restart; r.restart = false;
      if (again && r.server) { this.start(r.server); return; }
      if (crashed && r.server?.autoRestart) this.scheduleCrashRestart(r);
    });
    return { ok: true };
  }

  // At most 3 automatic restarts per 10 minutes, so a broken server cannot loop forever.
  scheduleCrashRestart(r) {
    const now = Date.now();
    r.crashes = r.crashes.filter((t) => now - t < 10 * 60_000);
    if (r.crashes.length >= 3) { this.push(r, "--- crashed 3 times in 10 minutes, auto-restart gave up ---", "sys"); return; }
    r.crashes.push(now);
    this.push(r, `--- crashed. Restarting in ${Math.round(this.crashRestartDelayMs / 1000)}s (attempt ${r.crashes.length}/3) ---`, "sys");
    clearTimeout(r.restartTimer);
    r.restartTimer = setTimeout(() => { if (!this.isActive(r.server.id)) this.start(r.server); }, this.crashRestartDelayMs);
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
    if (r) clearTimeout(r.restartTimer);
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
    if (r) clearTimeout(r.restartTimer);
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

  forget(id) {
    const r = this.recs.get(id);
    if (r) clearTimeout(r.restartTimer);
    this.recs.delete(id);
  }

  history(id) { return this.recs.get(id)?.hist.slice() ?? []; }

  info(id) {
    const r = this.recs.get(id);
    if (!r) return { status: "stopped", players: [], pid: null, startedAt: null, lastError: null, rssMb: null, cpu: null };
    return { status: r.status, players: [...r.players], pid: r.child?.pid ?? null, startedAt: r.startedAt, lastError: r.lastError, rssMb: r.child?.pid ? readRssMb(r.child.pid) : null, cpu: r.child ? r.cpu : null };
  }

  async shutdownAll() {
    clearInterval(this.sampler);
    for (const r of this.recs.values()) clearTimeout(r.restartTimer);
    const active = [...this.recs.entries()].filter(([, r]) => r.child);
    for (const [id] of active) this.stop(id);
    const end = Date.now() + 20_000;
    while (Date.now() < end && active.some(([, r]) => r.child)) await new Promise((r) => setTimeout(r, 200));
    for (const [, r] of active) if (r.child) r.child.kill("SIGKILL");
  }
}
