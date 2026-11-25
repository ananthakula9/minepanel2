import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import net from "node:net";
import { NgrokManager, diagnose, validToken } from "../server/lib/ngrok.mjs";
import { createApp } from "../server/app.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-test-"));
const fakeJava = path.join(tmp, "fake-java.mjs");
fs.writeFileSync(fakeJava, `#!/usr/bin/env node
console.log('[Server thread/INFO]: Starting minecraft server');
setTimeout(() => console.log('[Server thread/INFO]: Done (0.3s)! For help, type "help"'), 150);
process.stdin.on('data', (d) => {
  for (const l of d.toString().split('\\n').filter(Boolean)) {
    if (l === 'stop') { console.log('Stopping server'); process.exit(0); }
    else if (l === 'crash') process.exit(1);
    else if (l === 'join') console.log('[12:00:00] [Server thread/INFO]: Steve joined the game');
    else if (l === 'leave') console.log('[12:00:00] [Server thread/INFO]: Steve left the game');
    else console.log('echo: ' + l);
  }
});
`, { mode: 0o755 });


// ---- fake ngrok: behaves like the real agent for each kind of token, so every path can be tested ----
const fakeNgrok = path.join(tmp, "fake-ngrok.mjs");
fs.writeFileSync(fakeNgrok, `#!/usr/bin/env node
import fs from 'node:fs'; import http from 'node:http';
const a = process.argv.slice(2);
if (a[0] === 'version') { console.log('ngrok version 3.99.0'); process.exit(0); }
const tok = process.env.NGROK_AUTHTOKEN || '';
if (process.env.FAKE_REC) fs.writeFileSync(process.env.FAKE_REC, JSON.stringify({ argv: a, tokenEnv: tok, pid: process.pid }));
const port = a[1];
const L = (s) => console.log(s);
const url = (h, p) => L('t=2026-01-01T00:00:00+0000 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=//localhost:' + port + ' url=tcp://' + h + ':' + p);
if (tok.startsWith('badtoken')) { L('t=x lvl=eror msg="failed to auth" err="authentication failed: The authtoken you specified is invalid. ERR_NGROK_105"'); process.exit(1); }
if (tok.startsWith('needcard')) { L('t=x lvl=eror msg="failed" err="You must add a credit or debit card before you can use TCP endpoints"'); process.exit(1); }
if (tok.startsWith('dnsfail')) { L('t=x lvl=eror msg="failed" err="dial tcp: lookup connect.ngrok-agent.com on [::1]:53: read udp: connection refused"'); process.exit(1); }
if (tok.startsWith('busyagent')) { L('t=x lvl=eror msg="failed" err="Your account is limited to 1 simultaneous ngrok agent sessions. ERR_NGROK_108"'); process.exit(1); }
if (tok.startsWith('silent')) { L('t=x lvl=info msg="connecting"'); setInterval(() => {}, 1000); }
else if (tok.startsWith('apionly')) {
  http.createServer((q, r) => r.end(JSON.stringify({ tunnels: [{ public_url: 'tcp://9.tcp.fake.io:9999', config: { addr: 'localhost:1' } }, { public_url: 'tcp://7.tcp.fake.io:7777', config: { addr: 'localhost:' + port } }] }))).listen(Number(process.env.FAKE_NGROK_API));
  L('t=x lvl=info msg="no tunnel info in this log format"');
}
else if (tok.startsWith('decoy')) { L('t=x lvl=info msg="session" addr=tcp://connect.ngrok-agent.com:443'); setTimeout(() => url('0.tcp.fake.io', 12345), 300); setInterval(() => {}, 1000); }
else if (tok.startsWith('crashy')) { url('0.tcp.fake.io', 12345); setTimeout(() => process.exit(1), 800); }
else { L('t=x lvl=info msg="debug" tokenIs=' + tok); url('0.tcp.fake.io', 12345); setInterval(() => {}, 1000); }
`, { mode: 0o755 });
const fakeChroot = path.join(tmp, "fake-chroot.sh");
fs.writeFileSync(fakeChroot, '#!/bin/sh\necho ran > "$FAKE_CHROOT_MARK"\nexec "$@"\n', { mode: 0o755 });
const ngrokRec = path.join(tmp, "ngrok-rec.json");
process.env.FAKE_REC = ngrokRec;
process.env.FAKE_CHROOT_MARK = path.join(tmp, "chroot-mark");

let app, base, cookie = "";
const call = async (method, url, body, extra = {}) => {
  const headers = { "X-Requested-With": "minepanel", ...(cookie ? { Cookie: cookie } : {}), ...extra };
  let payload = body;
  if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string") { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers, body: payload });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error("timeout"); };

before(async () => {
  const apiPort = await new Promise((r) => { const sv = net.createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  process.env.FAKE_NGROK_API = String(apiPort);
  const modrinth = {
    search: async (q, gameVersion) => { if (q === "boom") throw new Error("offline"); return [{ id: "AbCd1234", slug: "demo", title: "Demo " + q, description: "d", downloads: 5, author: "me", gv: gameVersion }]; },
    install: async (project, gameVersion, destDir) => {
      if (project === "failfail") throw new Error("boom");
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, `${project}.jar`), "jar");
      return { filename: `${project}.jar`, version: "1.0.0", requires: [] };
    },
  };
  app = createApp({ dataDir: path.join(tmp, "data"), java: fakeJava, port: 0, host: "127.0.0.1", modrinth, crashRestartDelayMs: 150, backupSettleMs: 50, sampleMs: 100,
    ngrokPaths: ["/nonexistent/ngrok", fakeNgrok], ngrokApiPort: apiPort, ngrokStartTimeoutMs: 3500, chrootCmd: fakeChroot });
  const p = await app.listen();
  base = `http://127.0.0.1:${p}`;
});
after(async () => { await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("everything is locked before login and setup is required", async () => {
  assert.equal((await call("GET", "/api/servers")).status, 401);
  assert.equal((await call("GET", "/api/system")).status, 401);
  const st = await call("GET", "/api/state");
  assert.equal(st.json.setupRequired, true);
});

test("mutating requests without the custom header are refused", async () => {
  const res = await fetch(base + "/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});

test("setup validates, creates owner, then closes", async () => {
  assert.equal((await call("POST", "/api/setup", { username: "a", password: "longenough" })).status, 400);
  assert.equal((await call("POST", "/api/setup", { username: "owner", password: "short" })).status, 400);
  assert.equal((await call("POST", "/api/setup", { username: "owner", password: "correct horse" })).status, 200);
  assert.match(cookie, /^mp_session=[0-9a-f]{64}$/);
  assert.equal((await call("POST", "/api/setup", { username: "evil", password: "correct horse" })).status, 403);
  const db = fs.readFileSync(path.join(tmp, "data", "db.json"), "utf8");
  assert.ok(!db.includes("correct horse"), "password must not be stored in plain text");
});

test("logout, bad login, good login", async () => {
  await call("POST", "/api/logout", {});
  assert.equal((await call("GET", "/api/servers")).status, 401);
  assert.equal((await call("POST", "/api/login", { username: "owner", password: "wrong" })).status, 401);
  assert.equal((await call("POST", "/api/login", { username: "owner", password: "correct horse" })).status, 200);
  assert.equal((await call("GET", "/api/servers")).status, 200);
});

test("login is rate limited after repeated failures", async () => {
  const saved = cookie; cookie = "";
  let last;
  for (let i = 0; i < 6; i++) last = await call("POST", "/api/login", { username: "owner", password: "nope" });
  assert.equal(last.status, 429);
  cookie = saved;
});

let id;
test("create server validates input and requires EULA", async () => {
  const good = { name: "My Survival", type: "custom", ramMb: 512, port: 25570, eulaAccepted: true };
  assert.equal((await call("POST", "/api/servers", { ...good, eulaAccepted: false })).status, 400);
  assert.equal((await call("POST", "/api/servers", { ...good, ramMb: 10 })).status, 400);
  assert.equal((await call("POST", "/api/servers", { ...good, port: 80 })).status, 400);
  assert.equal((await call("POST", "/api/servers", { ...good, type: "evil" })).status, 400);
  const r = await call("POST", "/api/servers", good);
  assert.equal(r.status, 201);
  id = r.json.server.id;
  assert.equal(id, "my-survival");
  assert.equal(r.json.server.status, "needs-jar");
  assert.equal((await call("POST", "/api/servers", { ...good, name: "Other" })).status, 400, "duplicate port");
});

test("cannot start without a jar; does not pretend to run", async () => {
  const r = await call("POST", `/api/servers/${id}/start`, {});
  assert.equal(r.status, 409);
  assert.equal((await call("GET", `/api/servers/${id}`)).json.server.status, "needs-jar");
});

test("upload jar, start, status goes starting -> running, console works", async () => {
  const up = await call("PUT", `/api/servers/${id}/upload?path=server.jar`, new Uint8Array([1, 2, 3]), { "Content-Type": "application/octet-stream" });
  assert.equal(up.status, 200);
  assert.equal((await call("POST", `/api/servers/${id}/start`, {})).status, 200);
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.status === "running");

  assert.equal((await call("POST", `/api/servers/${id}/command`, { command: "/say hi" })).status, 200);
  await call("POST", `/api/servers/${id}/command`, { command: "join" });
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.players.includes("Steve"));
  await call("POST", `/api/servers/${id}/command`, { command: "leave" });
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.playerCount === 0);

  // live log stream replays history
  const ac = new AbortController();
  const res = await fetch(`${base}/api/servers/${id}/logs`, { headers: { Cookie: cookie }, signal: ac.signal });
  const reader = res.body.getReader();
  let text = "";
  while (!text.includes("echo: say hi")) { const { value } = await reader.read(); text += Buffer.from(value).toString(); }
  ac.abort();
  assert.match(text, /Done \(0\.3s\)/);
});

test("start twice and delete-while-running are refused", async () => {
  assert.equal((await call("POST", `/api/servers/${id}/start`, {})).status, 409);
  assert.equal((await call("DELETE", `/api/servers/${id}`)).status, 409);
  assert.equal((await call("PATCH", `/api/servers/${id}`, { ramMb: 1024 })).status, 409);
});

test("command without login is rejected", async () => {
  const saved = cookie; cookie = "";
  assert.equal((await call("POST", `/api/servers/${id}/command`, { command: "stop" })).status, 401);
  cookie = saved;
});

test("restart gives a new running process; stop really stops", async () => {
  const pid1 = (await call("GET", `/api/servers/${id}`)).json.server.pid;
  assert.equal((await call("POST", `/api/servers/${id}/restart`, {})).status, 200);
  await waitFor(async () => { const s = (await call("GET", `/api/servers/${id}`)).json.server; return s.status === "running" && s.pid !== pid1; });
  assert.equal((await call("POST", `/api/servers/${id}/stop`, {})).status, 200);
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.status === "stopped");
  const s = (await call("GET", `/api/servers/${id}`)).json.server;
  assert.equal(s.pid, null);
  assert.equal((await call("POST", `/api/servers/${id}/command`, { command: "list" })).status, 409);
});

test("a crash is reported as stopped with an error, never as running", async () => {
  await call("POST", `/api/servers/${id}/start`, {});
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.status === "running");
  await call("POST", `/api/servers/${id}/command`, { command: "crash" });
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.status === "stopped");
  const s = (await call("GET", `/api/servers/${id}`)).json.server;
  assert.match(s.error, /exited unexpectedly/);
  assert.equal(s.pid, null);
});

test("kill stops a running server immediately without an error", async () => {
  await call("POST", `/api/servers/${id}/start`, {});
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.status === "running");
  await call("POST", `/api/servers/${id}/kill`, {});
  await waitFor(async () => (await call("GET", `/api/servers/${id}`)).json.server.status === "stopped");
  assert.equal((await call("GET", `/api/servers/${id}`)).json.server.error, null);
});

test("file manager: list, edit, create, rename, delete, download", async () => {
  const l = await call("GET", `/api/servers/${id}/files?path=`);
  assert.ok(l.json.entries.some((e) => e.name === "server.properties" && e.size > 0));
  assert.equal((await call("PUT", `/api/servers/${id}/file`, { path: "notes/a.txt", content: "hello" })).status, 200);
  assert.equal((await call("GET", `/api/servers/${id}/file?path=notes/a.txt`)).json.content, "hello");
  assert.equal((await call("POST", `/api/servers/${id}/mkdir`, { path: "plugins" })).status, 200);
  assert.equal((await call("POST", `/api/servers/${id}/rename`, { from: "notes/a.txt", to: "notes/b.txt" })).status, 200);
  assert.equal((await call("GET", `/api/servers/${id}/download?path=notes/b.txt`)).text, "hello");
  assert.equal((await call("POST", `/api/servers/${id}/delete`, { path: "notes" })).status, 200);
  assert.equal((await call("POST", `/api/servers/${id}/delete`, { path: "" })).status, 400, "cannot delete root");
});

test("file manager blocks traversal and symlink escape", async () => {
  fs.writeFileSync(path.join(tmp, "secret.txt"), "top secret");
  fs.symlinkSync(tmp, path.join(tmp, "data", "servers", id, "evil"));
  for (const bad of ["../../../secret.txt", "..%2F..%2F..%2Fsecret.txt", "evil/secret.txt", "/../../secret.txt"]) {
    const r = await call("GET", `/api/servers/${id}/file?path=${bad}`);
    assert.notEqual(r.status, 200, bad);
    assert.ok(!r.text.includes("top secret"), bad);
  }
  assert.equal((await call("PUT", `/api/servers/${id}/file`, { path: "../x.txt", content: "x" })).status, 400);
  assert.equal((await call("PUT", `/api/servers/${id}/upload?path=evil/new.bin`, new Uint8Array([1]))).status, 400);
  assert.ok(!fs.existsSync(path.join(tmp, "x.txt")) && !fs.existsSync(path.join(tmp, "new.bin")));
  fs.rmSync(path.join(tmp, "data", "servers", id, "evil"));
});

test("properties editor keeps port locked and rejects bad values", async () => {
  const g = await call("GET", `/api/servers/${id}/properties`);
  assert.equal(g.json.properties["server-port"], "25570");
  assert.equal((await call("PUT", `/api/servers/${id}/properties`, { properties: { "max-players": "8", "server-port": "1234" } })).status, 200);
  const g2 = await call("GET", `/api/servers/${id}/properties`);
  assert.equal(g2.json.properties["max-players"], "8");
  assert.equal(g2.json.properties["server-port"], "25570");
  assert.equal((await call("PUT", `/api/servers/${id}/properties`, { properties: { "motd": "a\nop=true" } })).status, 400);
  assert.equal((await call("PUT", `/api/servers/${id}/properties`, { properties: { "Bad Key": "x" } })).status, 400);
});

test("settings change port, and delete removes the directory", async () => {
  assert.equal((await call("PATCH", `/api/servers/${id}`, { port: 25571 })).status, 200);
  assert.equal((await call("GET", `/api/servers/${id}/properties`)).json.properties["server-port"], "25571");
  assert.equal((await call("DELETE", `/api/servers/${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(tmp, "data", "servers", id)));
  assert.equal((await call("GET", `/api/servers/${id}`)).status, 404);
});

test("system stats are real numbers", async () => {
  const s = (await call("GET", "/api/system")).json;
  assert.ok(s.ram.totalMb > 0 && s.storage.totalMb > 0);
});

// ---------------------------------------------------------------------------------------
// Feature tests: metrics, players, plugins, backups, settings, crash auto-restart
// ---------------------------------------------------------------------------------------
const getServer = async (sid) => (await call("GET", `/api/servers/${sid}`)).json.server;
const waitStatus = (sid, st) => waitFor(async () => (await getServer(sid)).status === st);
const logsOf = (sid) => app.procs.rec(sid).logs.map((e) => e.line);

// minimal tar writer so we can build hostile archives without needing any tool
function tarBuf(entries) {
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    const data = Buffer.from(e.data || "");
    h.write(e.name, 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136);
    h.write("        ", 148); h.write(e.type || "0", 156); if (e.link) h.write(e.link, 157);
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

let fid;
test("feature server: create and start with jar", async () => {
  const r = await call("POST", "/api/servers", { name: "Feature", type: "custom", ramMb: 512, port: 25590, eulaAccepted: true });
  fid = r.json.server.id;
  await call("PUT", `/api/servers/${fid}/upload?path=server.jar`, new Uint8Array([1]));
  assert.equal((await call("POST", `/api/servers/${fid}/start`, {})).status, 200);
  await waitStatus(fid, "running");
});

test("metrics: real CPU/RAM history, disk size, uptime", async () => {
  const m = await waitFor(async () => { const x = (await call("GET", `/api/servers/${fid}/metrics`)).json; return x.history.length >= 3 ? x : null; });
  assert.equal(m.status, "running");
  assert.ok(m.history.every((h) => typeof h.cpu === "number" && h.cpu >= 0 && h.ramMb > 0), "samples have numbers");
  assert.ok(m.ramMb > 0 && m.ramLimitMb === 512 && m.uptimeSec >= 0 && m.diskMb >= 0);
  assert.equal((await call("GET", "/api/servers/nope/metrics")).status, 404);
});

test("players: lists come from the server's own files; actions only work while running", async () => {
  const dir = path.join(tmp, "data", "servers", fid);
  fs.writeFileSync(path.join(dir, "ops.json"), JSON.stringify([{ uuid: "u-1", name: "Alex", level: 4 }]));
  fs.writeFileSync(path.join(dir, "whitelist.json"), JSON.stringify([{ uuid: "u-2", name: "Sam" }]));
  fs.writeFileSync(path.join(dir, "banned-players.json"), JSON.stringify([{ uuid: "u-3", name: "Grief", reason: "x" }, { nope: 1 }]));
  fs.writeFileSync(path.join(dir, "server.properties"), "server-port=25590\nwhite-list=true\nonline-mode=false\n");
  const g = (await call("GET", `/api/servers/${fid}/players`)).json;
  assert.deepEqual(g.ops, [{ name: "Alex", uuid: "u-1", level: 4 }]);
  assert.equal(g.whitelist[0].name, "Sam");
  assert.equal(g.banned.length, 1, "malformed entries are skipped");
  assert.equal(g.whitelistEnabled, true);
  assert.equal(g.onlineMode, false);
  assert.equal(g.running, true);

  for (const [action, name, expect] of [["op", "Steve", "op Steve"], ["deop", "Steve", "deop Steve"], ["whitelist-add", "Steve", "whitelist add Steve"], ["whitelist-remove", "Steve", "whitelist remove Steve"], ["pardon", "Steve", "pardon Steve"], ["kick", "Steve", "kick Steve"]]) {
    assert.equal((await call("POST", `/api/servers/${fid}/player-action`, { action, name })).status, 200, action);
    assert.ok(logsOf(fid).includes(`> ${expect}`), expect);
  }
  assert.equal((await call("POST", `/api/servers/${fid}/player-action`, { action: "whitelist-on" })).status, 200);
  assert.ok(logsOf(fid).includes("> whitelist on"));
  // reason is flattened to one line so it cannot smuggle a second command
  await call("POST", `/api/servers/${fid}/player-action`, { action: "ban", name: "Steve", reason: "bad\nstop" });
  assert.ok(logsOf(fid).includes("> ban Steve bad stop"));
  assert.ok(!logsOf(fid).includes("> stop"));
  for (const name of ["a b", "x;stop", "", "waytoolongplayername1", "../x", 5, undefined]) {
    assert.equal((await call("POST", `/api/servers/${fid}/player-action`, { action: "op", name })).status, 400, String(name));
  }
  assert.equal((await call("POST", `/api/servers/${fid}/player-action`, { action: "format-c", name: "Steve" })).status, 400);
});

test("backup while running: save-off, save-all, archive, save-on", async () => {
  const dir = path.join(tmp, "data", "servers", fid);
  fs.mkdirSync(path.join(dir, "world"), { recursive: true });
  fs.writeFileSync(path.join(dir, "world", "level.dat"), "v1");
  const before = logsOf(fid).length;
  const r = await call("POST", `/api/servers/${fid}/backup-create`, {});
  assert.equal(r.status, 200);
  assert.match(r.json.name, /^backup-\d{8}-\d{6}\.tar\.gz$/);
  const cmds = logsOf(fid).slice(before).filter((l) => l.startsWith("> "));
  assert.deepEqual(cmds, ["> save-off", "> save-all flush", "> save-on"]);
  const l = (await call("GET", `/api/servers/${fid}/backups`)).json;
  assert.equal(l.backups.length, 1);
  assert.ok(l.backups[0].size > 0);
  assert.equal((await call("GET", `/api/servers/${fid}/backup-download?name=${r.json.name}`)).status, 200);
});

test("restore is refused while running; works when stopped; swap leaves no leftovers", async () => {
  const dir = path.join(tmp, "data", "servers", fid);
  const name = (await call("GET", `/api/servers/${fid}/backups`)).json.backups[0].name;
  assert.equal((await call("POST", `/api/servers/${fid}/backup-restore`, { name })).status, 409);
  fs.writeFileSync(path.join(dir, "world", "level.dat"), "v2-changed");
  fs.writeFileSync(path.join(dir, "added-later.txt"), "x");
  await call("POST", `/api/servers/${fid}/stop`, {});
  await waitStatus(fid, "stopped");
  assert.equal((await call("POST", `/api/servers/${fid}/backup-restore`, { name })).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, "world", "level.dat"), "utf8"), "v1");
  assert.ok(!fs.existsSync(path.join(dir, "added-later.txt")), "files made after the backup are gone, as in any restore");
  assert.deepEqual(fs.readdirSync(path.join(tmp, "data", "servers")).filter((n) => n.startsWith(".")), []);
  assert.ok(fs.existsSync(path.join(dir, "server.jar")), "server.jar was in the backup");
});

test("backup safety: bad names, hostile archives and the 10-backup limit", async () => {
  const bdir = path.join(tmp, "data", "backups", fid);
  for (const bad of ["../x.tar.gz", "backup-1.tar.gz", "x", "backup-20200101-000000.tar.gz/../../etc"]) {
    assert.equal((await call("POST", `/api/servers/${fid}/backup-delete`, { name: bad })).status, 400, bad);
    assert.equal((await call("GET", `/api/servers/${fid}/backup-download?name=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  assert.equal((await call("POST", `/api/servers/${fid}/backup-delete`, { name: "backup-20200101-000000.tar.gz" })).status, 404);

  const level = fs.readFileSync(path.join(tmp, "data", "servers", fid, "world", "level.dat"), "utf8");
  const evil = {
    "backup-20200101-000001.tar.gz": [{ name: "../escaped.txt", data: "pwned" }],
    "backup-20200101-000002.tar.gz": [{ name: "/abs-escaped.txt", data: "pwned" }],
    "backup-20200101-000003.tar.gz": [{ name: "link", type: "2", link: "/etc" }, { name: "ok.txt", data: "x" }],
  };
  for (const [n, entries] of Object.entries(evil)) {
    fs.writeFileSync(path.join(bdir, n), tarBuf(entries));
    const r = await call("POST", `/api/servers/${fid}/backup-restore`, { name: n });
    assert.equal(r.status, 409, n);
    assert.match(r.json.error, /refusing|unsafe/i, n);
  }
  assert.ok(!fs.existsSync(path.join(tmp, "data", "servers", "escaped.txt")) && !fs.existsSync("/abs-escaped.txt"));
  assert.equal(fs.readFileSync(path.join(tmp, "data", "servers", fid, "world", "level.dat"), "utf8"), level, "server untouched by refused restores");
  fs.writeFileSync(path.join(bdir, "backup-20200101-000004.tar.gz"), "not a tar at all");
  assert.equal((await call("POST", `/api/servers/${fid}/backup-restore`, { name: "backup-20200101-000004.tar.gz" })).status, 409);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "data", "servers")).filter((n) => n.startsWith(".")), [], "no temp dirs left behind");

  // fill to the limit
  for (let i = 10; i < 20; i++) fs.writeFileSync(path.join(bdir, `backup-20200101-0000${i}.tar.gz`), "x");
  const full = await call("POST", `/api/servers/${fid}/backup-create`, {});
  assert.equal(full.status, 409);
  assert.match(full.json.error, /Limit of 10/);
  for (const n of fs.readdirSync(bdir)) fs.rmSync(path.join(bdir, n));
});

test("plugins: list, toggle, delete, search and install (Modrinth stubbed)", async () => {
  assert.deepEqual((await call("GET", `/api/servers/${fid}/plugins`)).json.plugins, []);
  const inst = await call("POST", `/api/servers/${fid}/plugin-install`, { project: "AbCd1234" });
  assert.equal(inst.status, 200);
  assert.equal(inst.json.filename, "AbCd1234.jar");
  let list = (await call("GET", `/api/servers/${fid}/plugins`)).json.plugins;
  assert.deepEqual(list.map((p) => [p.name, p.enabled]), [["AbCd1234.jar", true]]);
  assert.equal((await call("POST", `/api/servers/${fid}/plugin-toggle`, { name: "AbCd1234.jar" })).status, 200);
  list = (await call("GET", `/api/servers/${fid}/plugins`)).json.plugins;
  assert.deepEqual(list.map((p) => [p.name, p.enabled]), [["AbCd1234.jar.disabled", false]]);
  assert.equal((await call("POST", `/api/servers/${fid}/plugin-toggle`, { name: "AbCd1234.jar.disabled" })).status, 200);
  assert.equal((await call("GET", `/api/servers/${fid}/plugins`)).json.plugins[0].enabled, true);
  // other files in plugins/ are not listed as plugins
  fs.writeFileSync(path.join(tmp, "data", "servers", fid, "plugins", "notes.txt"), "x");
  assert.equal((await call("GET", `/api/servers/${fid}/plugins`)).json.plugins.length, 1);

  for (const bad of ["../x.jar", "a/b.jar", "x.txt", "", "..", "x.jar/../../server.jar"]) {
    assert.equal((await call("POST", `/api/servers/${fid}/plugin-delete`, { name: bad })).status, 400, bad);
    assert.equal((await call("POST", `/api/servers/${fid}/plugin-toggle`, { name: bad })).status, 400, bad);
  }
  assert.ok(fs.existsSync(path.join(tmp, "data", "servers", fid, "server.jar")));
  assert.equal((await call("POST", `/api/servers/${fid}/plugin-delete`, { name: "ghost.jar" })).status, 404);

  assert.equal((await call("GET", `/api/servers/${fid}/plugin-search?q=a`)).status, 400);
  assert.equal((await call("GET", `/api/servers/${fid}/plugin-search?q=${"x".repeat(61)}`)).status, 400);
  assert.equal((await call("GET", `/api/servers/${fid}/plugin-search?q=boom`)).status, 502);
  const s = await call("GET", `/api/servers/${fid}/plugin-search?q=world`);
  assert.equal(s.json.results[0].title, "Demo world");
  assert.equal((await call("POST", `/api/servers/${fid}/plugin-install`, { project: "../etc" })).status, 400);
  assert.equal((await call("POST", `/api/servers/${fid}/plugin-install`, { project: "failfail" })).status, 502);
  assert.equal((await call("POST", `/api/servers/${fid}/plugin-delete`, { name: "AbCd1234.jar" })).status, 200);
  assert.deepEqual((await call("GET", `/api/servers/${fid}/plugins`)).json.plugins, []);
});

test("settings: changes are all-or-nothing; jar file and auto-restart", async () => {
  const before = await getServer(fid);
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { name: "Renamed", port: 80 })).status, 400);
  assert.equal((await getServer(fid)).name, before.name, "name must not change when another field is invalid");
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { jarFile: "missing.jar" })).status, 400);
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { jarFile: "../server.jar" })).status, 400);
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { jarFile: "server.txt" })).status, 400);
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { autoRestart: "yes" })).status, 400);
  await call("PUT", `/api/servers/${fid}/upload?path=custom-paper.jar`, new Uint8Array([2]));
  const ok = await call("PATCH", `/api/servers/${fid}`, { jarFile: "custom-paper.jar", name: "Renamed" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.server.jarFile, "custom-paper.jar");
  // the new jar is really what gets used: remove the old one and it still starts
  fs.rmSync(path.join(tmp, "data", "servers", fid, "server.jar"));
  assert.equal((await call("POST", `/api/servers/${fid}/start`, {})).status, 200);
  await waitStatus(fid, "running");
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { jarFile: "server.jar" })).status, 409, "cannot change jar while running");
  await call("POST", `/api/servers/${fid}/stop`, {});
  await waitStatus(fid, "stopped");
  fs.rmSync(path.join(tmp, "data", "servers", fid, "custom-paper.jar"));
  assert.equal((await getServer(fid)).status, "needs-jar", "status reflects the configured jar");
  fs.writeFileSync(path.join(tmp, "data", "servers", fid, "custom-paper.jar"), "j");
});

test("auto-restart: restarts after a crash, never after Stop or Kill, gives up after 3 crashes", async () => {
  assert.equal((await call("PATCH", `/api/servers/${fid}`, { autoRestart: true })).json.server.autoRestart, true);
  await call("POST", `/api/servers/${fid}/start`, {});
  await waitStatus(fid, "running");
  // Stop and Kill are deliberate: no restart
  await call("POST", `/api/servers/${fid}/stop`, {});
  await waitStatus(fid, "stopped");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await getServer(fid)).status, "stopped");
  await call("POST", `/api/servers/${fid}/start`, {});
  await waitStatus(fid, "running");
  await call("POST", `/api/servers/${fid}/kill`, {});
  await waitStatus(fid, "stopped");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await getServer(fid)).status, "stopped");
  // crashes
  await call("POST", `/api/servers/${fid}/start`, {});
  await waitStatus(fid, "running");
  for (let i = 1; i <= 3; i++) {
    const pid = (await getServer(fid)).pid;
    await call("POST", `/api/servers/${fid}/command`, { command: "crash" });
    await waitFor(async () => { const s = await getServer(fid); return s.status === "running" && s.pid !== pid; }, 6000);
    assert.ok(logsOf(fid).some((l) => l.includes(`attempt ${i}/3`)), `attempt ${i}`);
  }
  await call("POST", `/api/servers/${fid}/command`, { command: "crash" });
  await waitStatus(fid, "stopped");
  await new Promise((r) => setTimeout(r, 600));
  const s = await getServer(fid);
  assert.equal(s.status, "stopped");
  assert.match(s.error, /exited unexpectedly/);
  assert.ok(logsOf(fid).some((l) => l.includes("auto-restart gave up")));
});

test("deleting a server also removes its backups", async () => {
  fs.mkdirSync(path.join(tmp, "data", "backups", fid), { recursive: true });
  fs.writeFileSync(path.join(tmp, "data", "backups", fid, "backup-20200101-000000.tar.gz"), "x");
  assert.equal((await call("DELETE", `/api/servers/${fid}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(tmp, "data", "backups", fid)));
  assert.ok(!fs.existsSync(path.join(tmp, "data", "servers", fid)));
});

// ---------------------------------------------------------------------------------------
// ngrok tunnel (fake ngrok binary)
// ---------------------------------------------------------------------------------------
const ngrokState = async () => (await call("GET", "/api/ngrok")).json;
const waitTunnel = (st) => waitFor(async () => (await ngrokState()).tunnel.state === st, 9000);
const goodToken = "goodtoken_1234567890abcdef";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const useToken = async (tok) => { await call("POST", "/api/ngrok/stop", {}); return call("PUT", "/api/ngrok/settings", { authtoken: tok }); };
let tA, tB;

test("ngrok: finds the binary (skipping missing candidates); token handling and validation", async () => {
  const mk = async (name, port) => (await call("POST", "/api/servers", { name, type: "custom", ramMb: 512, port, eulaAccepted: true })).json.server.id;
  tA = await mk("Tun A", 25601); tB = await mk("Tun B", 25602);
  let n = await ngrokState();
  assert.equal(n.installed, true);
  assert.equal(n.binaryPath, fakeNgrok);
  assert.equal(n.version, "ngrok version 3.99.0");
  assert.equal(n.tokenSet, false);
  assert.equal(n.tunnel.state, "idle");
  assert.equal((await call("POST", "/api/ngrok/start", { serverId: tA })).status, 400, "no token yet");
  for (const bad of ["short", "has spaces in it 1234567890", "x".repeat(121), "bad;token;1234567890abc", 123]) assert.equal((await call("PUT", "/api/ngrok/settings", { authtoken: bad })).status, 400, String(bad));
  assert.equal((await call("PUT", "/api/ngrok/settings", { useChroot: "yes" })).status, 400);
  assert.equal((await call("PUT", "/api/ngrok/settings", { authtoken: goodToken })).status, 200);
  n = await ngrokState();
  assert.equal(n.tokenSet, true);
  assert.equal(n.tokenHint, "cdef");
  assert.ok(!JSON.stringify(n).includes(goodToken), "the token is never sent back to the browser");
  const dbFile = path.join(tmp, "data", "db.json");
  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600, "database file is private to the owner");
  const saved = cookie; cookie = "";
  try { for (const [m, u] of [["GET", "/api/ngrok"], ["PUT", "/api/ngrok/settings"], ["POST", "/api/ngrok/start"], ["POST", "/api/ngrok/stop"]]) assert.equal((await call(m, u, m === "GET" ? undefined : {})).status, 401, u); }
  finally { cookie = saved; }
});

test("ngrok: tunnel goes online, shows the public address, token goes in env not argv, token is redacted in logs", async () => {
  assert.equal((await call("POST", "/api/ngrok/start", { serverId: "nope" })).status, 404);
  assert.equal((await call("POST", "/api/ngrok/start", { serverId: tA })).status, 200);
  await waitTunnel("online");
  const n = await ngrokState();
  assert.equal(n.tunnel.address, "0.tcp.fake.io:12345");
  assert.equal(n.tunnel.serverId, tA);
  const rec = JSON.parse(fs.readFileSync(ngrokRec, "utf8"));
  assert.deepEqual(rec.argv, ["tcp", "25601", "--log=stdout"]);
  assert.equal(rec.tokenEnv, goodToken, "token reaches ngrok through NGROK_AUTHTOKEN");
  assert.ok(!rec.argv.join(" ").includes(goodToken), "token is not on the command line");
  const logs = n.tunnel.logs.join("\n");
  assert.ok(!logs.includes(goodToken) && logs.includes("tokenIs=***"), "token is redacted from logs");
  assert.equal((await getServer(tA)).publicAddress, "0.tcp.fake.io:12345");
  assert.equal((await getServer(tB)).publicAddress, null);
  const list = (await call("GET", "/api/servers")).json.servers;
  assert.equal(list.find((s) => s.id === tA).publicAddress, "0.tcp.fake.io:12345");
});

test("ngrok: settings and port are locked while the tunnel runs; starting another server switches the tunnel", async () => {
  assert.equal((await call("PUT", "/api/ngrok/settings", { authtoken: "othertoken_1234567890abc" })).status, 409);
  assert.equal((await call("PATCH", `/api/servers/${tA}`, { port: 25611 })).status, 409);
  assert.equal((await call("PATCH", `/api/servers/${tB}`, { port: 25612 })).status, 200, "other servers are unaffected");
  await call("PATCH", `/api/servers/${tB}`, { port: 25602 });
  const pid1 = JSON.parse(fs.readFileSync(ngrokRec, "utf8")).pid;
  assert.equal((await call("POST", "/api/ngrok/start", { serverId: tB })).status, 200);
  await waitFor(async () => { const t = (await ngrokState()).tunnel; return t.state === "online" && t.serverId === tB; });
  assert.ok(!alive(pid1), "the first ngrok process was stopped");
  assert.equal(JSON.parse(fs.readFileSync(ngrokRec, "utf8")).argv[1], "25602");
  assert.equal((await getServer(tA)).publicAddress, null);
  assert.equal((await getServer(tB)).publicAddress, "0.tcp.fake.io:12345");
});

test("ngrok: Stop really kills the process; deleting a server stops its tunnel", async () => {
  const pid = JSON.parse(fs.readFileSync(ngrokRec, "utf8")).pid;
  assert.ok(alive(pid));
  assert.equal((await call("POST", "/api/ngrok/stop", {})).status, 200);
  assert.ok(!alive(pid), "process is gone");
  const n = await ngrokState();
  assert.equal(n.tunnel.state, "idle");
  assert.equal((await getServer(tB)).publicAddress, null);
  await call("POST", "/api/ngrok/start", { serverId: tB });
  await waitTunnel("online");
  const pid2 = JSON.parse(fs.readFileSync(ngrokRec, "utf8")).pid;
  assert.equal((await call("DELETE", `/api/servers/${tB}`)).status, 200);
  assert.ok(!alive(pid2), "deleting the server stopped its tunnel");
  assert.equal((await ngrokState()).tunnel.state, "idle");
});

test("ngrok: each failure shows a helpful message", async () => {
  const cases = [
    ["badtoken_1234567890abcdef", /rejected the auth token/],
    ["needcard_1234567890abcdef", /credit or debit card/],
    ["dnsfail_1234567890abcdef", /termux-chroot/],
    ["busyagent_1234567890abcdef", /pkill ngrok/],
  ];
  for (const [tok, re] of cases) {
    assert.equal((await useToken(tok)).status, 200);
    assert.equal((await call("POST", "/api/ngrok/start", { serverId: tA })).status, 200);
    await waitTunnel("error");
    const t = (await ngrokState()).tunnel;
    assert.match(t.hint, re, tok);
    assert.match(t.error, /exited before giving an address/);
    assert.equal(t.address, null);
    assert.equal((await getServer(tA)).publicAddress, null, "never shows an address that does not work");
  }
});

test("ngrok: silent ngrok times out and is killed; crash after going online clears the address", async () => {
  await useToken("silent_1234567890abcdef");
  await call("POST", "/api/ngrok/start", { serverId: tA });
  const pid = await waitFor(async () => { try { return JSON.parse(fs.readFileSync(ngrokRec, "utf8")).pid; } catch { return null; } });
  await waitTunnel("error");
  const t = (await ngrokState()).tunnel;
  assert.match(t.error, /did not report an address within 4 seconds|did not report an address/);
  await waitFor(async () => !alive(pid), 4000);

  await useToken("crashy_1234567890abcdef");
  await call("POST", "/api/ngrok/start", { serverId: tA });
  await waitTunnel("online");
  assert.equal((await getServer(tA)).publicAddress, "0.tcp.fake.io:12345");
  await waitTunnel("error");
  assert.match((await ngrokState()).tunnel.error, /stopped unexpectedly/);
  assert.equal((await getServer(tA)).publicAddress, null);
});

test("ngrok: address found through ngrok's local API when logs differ; log decoys are ignored", async () => {
  await useToken("apionly_1234567890abcdef");
  await call("POST", "/api/ngrok/start", { serverId: tA });
  await waitTunnel("online");
  assert.equal((await ngrokState()).tunnel.address, "7.tcp.fake.io:7777", "matched the tunnel for OUR port, not the other one");

  await useToken("decoy_1234567890abcdef");
  await call("POST", "/api/ngrok/start", { serverId: tA });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await ngrokState()).tunnel.state, "starting", "a tcp:// address that is not a tunnel url is not mistaken for one");
  await waitTunnel("online");
  assert.equal((await ngrokState()).tunnel.address, "0.tcp.fake.io:12345");
});

test("ngrok: optional termux-chroot mode runs ngrok through the wrapper", async () => {
  await useToken(goodToken);
  fs.rmSync(process.env.FAKE_CHROOT_MARK, { force: true });
  assert.equal((await call("PUT", "/api/ngrok/settings", { useChroot: true })).status, 200);
  assert.equal((await ngrokState()).useChroot, true);
  await call("POST", "/api/ngrok/start", { serverId: tA });
  await waitTunnel("online");
  assert.ok(fs.existsSync(process.env.FAKE_CHROOT_MARK), "wrapper was used");
  assert.deepEqual(JSON.parse(fs.readFileSync(ngrokRec, "utf8")).argv, ["tcp", "25601", "--log=stdout"]);
  await call("POST", "/api/ngrok/stop", {});
  await call("PUT", "/api/ngrok/settings", { useChroot: false });
  fs.rmSync(process.env.FAKE_CHROOT_MARK, { force: true });
  await call("POST", "/api/ngrok/start", { serverId: tA });
  await waitTunnel("online");
  assert.ok(!fs.existsSync(process.env.FAKE_CHROOT_MARK), "wrapper not used when switched off");
  await call("POST", "/api/ngrok/stop", {});
  assert.equal((await call("PUT", "/api/ngrok/settings", { authtoken: "" })).status, 200, "empty token removes it");
  assert.equal((await ngrokState()).tokenSet, false);
});

test("ngrok manager: not installed, missing chroot, token validation, advice text", async () => {
  const settings = { authtoken: goodToken };
  const none = new NgrokManager({ getSettings: () => settings, candidates: ["/nonexistent/ngrok"] });
  assert.equal(await none.locate(), null);
  await assert.rejects(() => none.start("x", 25565), /not installed/);
  const noChroot = new NgrokManager({ getSettings: () => ({ ...settings, useChroot: true }), candidates: [fakeNgrok], chrootCmd: "/nonexistent/chroot-cmd" });
  await noChroot.start("x", 25565);
  await waitFor(async () => noChroot.view().state === "error");
  assert.match(noChroot.view().error, /pkg install proot/);
  await assert.rejects(() => new NgrokManager({ getSettings: () => ({}), candidates: [fakeNgrok] }).start("x", 1), /auth token/);
  assert.equal(validToken("abcdefghijklmnop"), true);
  assert.equal(validToken("abc"), false);
  assert.equal(validToken("abcdefghijklmnop;rm"), false);
  assert.equal(diagnose("everything is fine"), null);
  assert.equal(diagnose("lvl=info msg=hello"), null);
});
