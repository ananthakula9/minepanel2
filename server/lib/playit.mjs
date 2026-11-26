// Runs the playit.gg agent as a child process. The agent forwards a public address to this phone.
// The secret key (if you use one) goes to the agent through the environment, never on the command line.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SECRET_RE = /^[A-Za-z0-9_-]{16,200}$/;
export const validSecret = (s) => typeof s === "string" && SECRET_RE.test(s);
const CLAIM_RE = /https:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]{4,100}/;
const HOST_RE = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}|\d{1,3}(?:\.\d{1,3}){3})$/;
const MAX_LOG = 60;

// Accepts "xx-xx.craft.playit.gg", "https://xx.ply.gg:12345/" etc. Returns "host" or "host:port", or null.
export function cleanAddress(v) {
  if (typeof v !== "string") return null;
  const a = v.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  const m = a.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!m || !HOST_RE.test(m[1])) return null;
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return null;
  return a;
}

export function diagnose(text) {
  if (/exec format error|cannot execute binary|bad cpu type/i.test(text))
    return "This playit file is for a different kind of device. On a phone you need the Linux ARM64 (aarch64) build.";
  if (/permission denied/i.test(text)) return "Android refused to run the file. In Termux run: chmod +x ~/playit";
  if (/secret.{0,40}(invalid|not found|rejected|unauthori[sz]ed)|(invalid|unknown|bad).{0,20}secret|unauthori[sz]ed|\b401\b/i.test(text))
    return "playit rejected the secret key. Create a new agent at playit.gg/account/agents and save its secret key here.";
  if (/lookup .* on \[::1\]:53|no such host|temporary failure in name resolution|dns error/i.test(text))
    return "playit could not look up DNS on this phone. Check that the phone has internet, then try again.";
  if (/x509|certificate/i.test(text)) return "playit could not verify its secure connection. Check that your phone's date and time are correct.";
  return null;
}

// Finds an executable by path or on PATH.
function findExe(name) {
  const ok = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  if (name.includes("/")) return ok(name) ? name : null;
  for (const d of (process.env.PATH || "").split(path.delimiter)) if (d && ok(path.join(d, name))) return path.join(d, name);
  return null;
}
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, so, se) => resolve(err ? null : String(so || se).trim().split("\n")[0].slice(0, 120))));

export class PlayitManager {
  constructor({ getSettings, candidates, graceMs = 4000 }) {
    this.getSettings = getSettings;
    const home = os.homedir();
    this.candidates = candidates || [process.env.PLAYIT, "playit", path.join(home, "playit"), path.join(home, "bin", "playit")].filter(Boolean);
    this.graceMs = graceMs; this.located = null;
    this.reset();
  }
  reset() {
    clearTimeout(this.grace);
    this.t = { state: "idle", startedAt: null, error: null, hint: null, claimUrl: null, logs: [] };
    this.child = null; this.stopping = false;
  }
  async locate(force = false) {
    if (!force && this.located && Date.now() - this.located.at < 10_000) return this.located.value;
    let value = null;
    for (const c of this.candidates) { const p = findExe(c); if (p) { value = { path: p, version: await run(p, ["--version"]) }; break; } }
    this.located = { at: Date.now(), value };
    return value;
  }
  view() { const t = this.t; return { state: t.state, startedAt: t.startedAt, error: t.error, hint: t.hint, claimUrl: t.claimUrl, logs: t.logs.slice(-25) }; }
  isActive() { return ["starting", "running"].includes(this.t.state); }

  log(line) {
    const secret = this.getSettings().secret;
    let clean = String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f]/g, "").slice(0, 400);
    if (secret) clean = clean.split(secret).join("***");
    if (!clean.trim()) return;
    this.t.logs.push(clean); if (this.t.logs.length > MAX_LOG) this.t.logs.shift();
    const m = clean.match(CLAIM_RE); if (m) this.t.claimUrl = m[0];
  }
  fail(message) { clearTimeout(this.grace); this.t.state = "error"; this.t.error = message; this.t.hint = diagnose(this.t.logs.join("\n")); }

  async start() {
    if (this.isActive()) return;
    const bin = await this.locate();
    if (!bin) throw new Error("playit is not installed on this device");
    this.reset();
    this.t.state = "starting";
    const secret = this.getSettings().secret;
    const env = { ...process.env }; delete env.SECRET_KEY; delete env.PLAYIT_SECRET;
    if (validSecret(secret)) { env.SECRET_KEY = secret; env.PLAYIT_SECRET = secret; }
    const child = spawn(bin.path, [], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.child = child;
    let buf = "";
    const onData = (d) => { buf += d.toString("utf8"); let i; while ((i = buf.search(/[\r\n]/)) >= 0) { this.log(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("error", (e) => { if (this.child !== child) return; this.child = null; this.fail(e.message); });
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null; if (buf.trim()) this.log(buf);
      if (!this.stopping) this.fail(`playit stopped (${code !== null ? `code ${code}` : signal}), so the public address no longer works`);
    });
    // "running" only means the program is still alive after a few seconds. Whether it is connected is shown in its own log and on playit.gg.
    this.grace = setTimeout(() => { if (this.child === child && this.t.state === "starting") { this.t.state = "running"; this.t.startedAt = Date.now(); } }, this.graceMs);
    this.grace.unref?.();
  }
  killGroup(child, sig = "SIGTERM") { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } }
  async stop() {
    const child = this.child; this.stopping = true;
    if (child) {
      this.child = null;
      await new Promise((resolve) => {
        const force = setTimeout(() => { this.killGroup(child, "SIGKILL"); setTimeout(resolve, 200); }, 3000);
        child.once("exit", () => { clearTimeout(force); resolve(); });
        this.killGroup(child);
      });
    }
    this.reset();
  }
}
