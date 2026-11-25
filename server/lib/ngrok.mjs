// Runs ONE ngrok TCP tunnel at a time (the free plan allows one agent session).
// The auth token is passed through the NGROK_AUTHTOKEN environment variable, never on the command line.
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,120}$/;
export const validToken = (t) => typeof t === "string" && TOKEN_RE.test(t);

// Matches e.g.  url=tcp://0.tcp.ngrok.io:12345   or   "url":"tcp://0.tcp.ngrok.io:12345"
const URL_RE = /\burl"?\s*[=:]\s*"?tcp:\/\/([A-Za-z0-9.-]{1,100}):(\d{1,5})\b/;
const MAX_LOG = 60;

// Turns ngrok's raw output into advice a person can act on. Returns null when nothing is recognised.
export function diagnose(text) {
  if (/authentication failed|ERR_NGROK_105|ERR_NGROK_107|invalid authtoken|proper ngrok authtoken/i.test(text))
    return "ngrok rejected the auth token. Copy it again from dashboard.ngrok.com/get-started/your-authtoken and save it here.";
  if (/(credit|debit) card|payment method|add a card/i.test(text))
    return "ngrok needs a credit or debit card on your account before it allows TCP tunnels, even on the free plan (it is not charged). Add one in the ngrok dashboard under Billing, then start again.";
  if (/ERR_NGROK_108|simultaneous ngrok agent sessions|only \d+ simultaneous/i.test(text))
    return "Your ngrok account is already running another agent (another phone, PC or an old ngrok process). Free accounts allow one. Stop it (in Termux: pkill ngrok) and try again.";
  if (/lookup .* on \[::1\]:53|no such host|server misbehaving|temporary failure in name resolution/i.test(text))
    return "ngrok cannot look up DNS on this phone (a known problem with Go programs in Termux). Turn on 'Run ngrok through termux-chroot' below, after running: pkg install proot";
  if (/x509|certificate/i.test(text))
    return "ngrok could not verify its secure connection. Check that your phone's date and time are correct.";
  return null;
}

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: process.env }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve(String(stdout || stderr).trim().split("\n")[0].slice(0, 120));
    });
  });
}

export class NgrokManager {
  constructor({ getSettings, candidates, apiPort = 4040, startTimeoutMs = 30_000, chrootCmd = "termux-chroot" }) {
    this.getSettings = getSettings;
    const home = os.homedir();
    this.candidates = candidates || [process.env.NGROK, "ngrok", path.join(home, "ngrok"), path.join(home, "bin", "ngrok")].filter(Boolean);
    this.apiPort = apiPort;
    this.startTimeoutMs = startTimeoutMs;
    this.chrootCmd = chrootCmd;
    this.located = null; // { at, value }
    this.reset();
  }

  reset() {
    this.t = { state: "idle", serverId: null, port: null, address: null, startedAt: null, error: null, hint: null, logs: [] };
    this.child = null; this.stopping = false;
    clearTimeout(this.timeout); clearInterval(this.poller);
  }

  // Finds a working ngrok binary. Result is cached for 10 s unless force is set.
  async locate(force = false) {
    if (!force && this.located && Date.now() - this.located.at < 10_000) return this.located.value;
    let value = null;
    for (const c of this.candidates) {
      const version = await run(c, ["version"]);
      if (version) { value = { path: c, version }; break; }
    }
    this.located = { at: Date.now(), value };
    return value;
  }

  view() {
    const t = this.t;
    return { state: t.state, serverId: t.serverId, port: t.port, address: t.address, startedAt: t.startedAt, error: t.error, hint: t.hint, logs: t.logs.slice(-25) };
  }
  addressFor(serverId) { return this.t.state === "online" && this.t.serverId === serverId ? this.t.address : null; }
  isActive(serverId) { return ["starting", "online"].includes(this.t.state) && (serverId == null || this.t.serverId === serverId); }

  log(line) {
    const token = this.getSettings().authtoken;
    let clean = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").slice(0, 400);
    if (token) clean = clean.split(token).join("***");
    if (!clean.trim()) return;
    this.t.logs.push(clean);
    if (this.t.logs.length > MAX_LOG) this.t.logs.shift();
    if (this.t.state === "starting") { const m = clean.match(URL_RE); if (m) this.online(m[1], m[2]); }
  }

  online(host, port) {
    if (this.t.state !== "starting") return;
    clearTimeout(this.timeout); clearInterval(this.poller);
    this.t.state = "online"; this.t.address = `${host}:${port}`; this.t.startedAt = Date.now();
  }

  fail(message) {
    clearTimeout(this.timeout); clearInterval(this.poller);
    const hint = diagnose(this.t.logs.join("\n"));
    this.t.state = "error"; this.t.error = message; this.t.hint = hint; this.t.address = null;
  }

  async start(serverId, port) {
    if (this.isActive()) await this.stop();
    const settings = this.getSettings();
    if (!validToken(settings.authtoken)) throw new Error("Save your ngrok auth token first");
    const bin = await this.locate();
    if (!bin) throw new Error("ngrok is not installed on this device");
    this.reset();
    this.t.state = "starting"; this.t.serverId = serverId; this.t.port = port;

    const args = ["tcp", String(port), "--log=stdout"];
    const [cmd, cmdArgs] = settings.useChroot ? [this.chrootCmd, [bin.path, ...args]] : [bin.path, args];
    const child = spawn(cmd, cmdArgs, { env: { ...process.env, NGROK_AUTHTOKEN: settings.authtoken }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.child = child;

    let buf = "";
    const onData = (d) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { this.log(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("error", (e) => { if (this.child !== child) return; this.child = null; this.fail(e.code === "ENOENT" ? `Could not run "${cmd}". ${settings.useChroot ? "Install it with: pkg install proot" : ""}`.trim() : e.message); });
    child.on("close", (code, signal) => { // "close" fires after all output has been read, so error text is never lost
      if (this.child !== child) return;
      this.child = null;
      if (buf.trim()) this.log(buf);
      if (this.stopping) return;
      if (this.t.state === "starting" || this.t.state === "online") this.fail(this.t.state === "online" ? "ngrok stopped unexpectedly, so the public address no longer works" : `ngrok exited before giving an address (code ${code ?? signal})`);
    });

    // Fallback: ask ngrok's local API in case the log format differs from what we expect.
    this.poller = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${this.apiPort}/api/tunnels`, { signal: AbortSignal.timeout(1500) });
        const j = await r.json();
        const hit = (j.tunnels || []).find((x) => /^tcp:\/\//.test(x.public_url || "") && String(x.config?.addr || "").endsWith(`:${port}`));
        const m = hit?.public_url.match(/^tcp:\/\/([A-Za-z0-9.-]{1,100}):(\d{1,5})$/);
        if (m && this.child === child) this.online(m[1], m[2]);
      } catch {}
    }, 1500);
    this.poller.unref?.();

    this.timeout = setTimeout(() => {
      if (this.t.state !== "starting" || this.child !== child) return;
      this.fail(`ngrok did not report an address within ${Math.round(this.startTimeoutMs / 1000)} seconds`);
      this.killGroup(child);
    }, this.startTimeoutMs);
    this.timeout.unref?.();
  }

  killGroup(child, sig = "SIGTERM") {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
  }

  async stop() {
    const child = this.child;
    this.stopping = true;
    if (child) {
      this.child = null;
      await new Promise((resolve) => {
        const done = () => { clearTimeout(force); resolve(); };
        const force = setTimeout(() => { this.killGroup(child, "SIGKILL"); setTimeout(resolve, 200); }, 3000);
        child.once("exit", done);
        this.killGroup(child);
      });
    }
    this.reset();
  }
}
