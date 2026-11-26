import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import net from "node:net";
import { PlayitManager, cleanAddress, validSecret, diagnose } from "../server/lib/playit.mjs";
import { createApp as createApp2 } from "../server/app.mjs";
import { createApp } from "../server/app.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mp-test-"));
const fakeJava = path.join(tmp, "fake-java.mjs");
fs.writeFileSync(fakeJava, `#!/usr/bin/env node
console.log('[Server thread/INFO]: Starting minecraft server');
setTimeout(() => console.log('[Server thread/INFO]: Done (0.3s)! For help, type "help"'), 150);
console.log('ARGV: ' + process.argv.slice(2).join(' '));
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


// ---- fake playit agent: behaves differently for each kind of secret so every path can be tested ----
const fakePlayit = path.join(tmp, "fake-playit.mjs");
fs.writeFileSync(fakePlayit, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('playit 1.0.10'); process.exit(0); }
const sec = process.env.SECRET_KEY || '';
if (process.env.FAKE_REC) fs.writeFileSync(process.env.FAKE_REC, JSON.stringify({ argv: a, secretEnv: sec, plEnv: process.env.PLAYIT_SECRET || '', pid: process.pid }));
const L = (s) => console.log(s);
if (sec.startsWith('badsecret')) { L('error: the secret key was rejected: unauthorized'); process.exit(1); }
if (sec.startsWith('crashy')) { L('agent connected'); setTimeout(() => process.exit(3), 1600); }
else if (!sec) { L('\\x1b[32mVisit link to setup https://playit.gg/claim/abcd1234EFGH\\x1b[0m'); setInterval(() => {}, 1000); }
else { L('agent started, secret is ' + sec); setInterval(() => {}, 1000); }
`, { mode: 0o755 });
const playitRec = path.join(tmp, "playit-rec.json");
process.env.FAKE_REC = playitRec;
const SECRET = "goodsecret0123456789abcdef0123456789abcdef";

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
    playitPaths: ["/nonexistent/playit", fakePlayit], playitGraceMs: 700 });
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
// playit.gg
const pl = async () => (await call("GET", "/api/playit")).json;
const waitAgent = (st) => waitFor(async () => (await pl()).agent.state === st, 9000);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rec = () => JSON.parse(fs.readFileSync(playitRec, "utf8"));
const mkSrv = async (name, port) => (await call("POST", "/api/servers", { name, type: "custom", ramMb: 512, port, eulaAccepted: true })).json.server.id;

test("playit helpers: address cleaning, secret check, advice text", () => {
  assert.equal(cleanAddress("XX-XX.craft.playit.gg"), "xx-xx.craft.playit.gg");
  assert.equal(cleanAddress(" https://abc.ply.gg:12345/ "), "abc.ply.gg:12345");
  assert.equal(cleanAddress("147.185.221.9:25565"), "147.185.221.9:25565");
  for (const bad of ["", "nodots", "a b.gg", "x.gg:0", "x.gg:99999", "x.gg:abc", "-x.gg", "x..gg", 5, null]) assert.equal(cleanAddress(bad), null, String(bad));
  assert.equal(validSecret(SECRET), true);
  for (const bad of ["short", "has space 0123456789abcdef", "a;b0123456789abcdef", SECRET + "\n", 5]) assert.equal(validSecret(bad), false);
  assert.match(diagnose("error: the secret key was rejected: unauthorized"), /secret key/);
  assert.match(diagnose("fork/exec: exec format error"), /ARM64/);
  assert.match(diagnose("bash: permission denied"), /chmod \+x/);
  assert.equal(diagnose("all good"), null);
});

test("playit: finds the program (skips missing ones); secret validation, privacy, auth", async () => {
  let d = await pl();
  assert.equal(d.installed, true); assert.equal(d.binaryPath, fakePlayit); assert.equal(d.version, "playit 1.0.10");
  assert.equal(d.secretSet, false);
  const put = (b) => call("PUT", "/api/playit/settings", b);
  for (const bad of ["short", "has space 0123456789abcdef", "x;y0123456789abcdefg", 5]) assert.equal((await put({ secret: bad })).status, 400, String(bad));
  assert.equal((await put({})).status, 400);
  const r = await put({ secret: SECRET });
  assert.equal(r.status, 200); assert.ok(!r.text.includes(SECRET), "secret not echoed");
  d = await pl();
  assert.equal(d.secretSet, true); assert.equal(d.secretHint, SECRET.slice(-4)); assert.equal(d.secretSource, "panel");
  assert.ok(!JSON.stringify(d).includes(SECRET), "secret never returned to the browser");
  const dbFile = path.join(tmp, "data", "db.json");
  assert.equal(JSON.parse(fs.readFileSync(dbFile, "utf8")).playit.secret, SECRET);
  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600);
  for (const [m, u] of [["GET", "/api/playit"], ["PUT", "/api/playit/settings"], ["PUT", "/api/playit/address"], ["POST", "/api/playit/start"], ["POST", "/api/playit/stop"]])
    assert.equal((await fetch(base + u, { method: m, headers: { "X-Requested-With": "minepanel", "Content-Type": "application/json" }, body: m === "GET" ? undefined : "{}" })).status, 401, u);
});

test("playit agent: starts with the secret in the environment (not argv), runs, redacts logs, Stop kills it", async () => {
  assert.equal((await call("POST", "/api/playit/start", {})).status, 200);
  assert.equal((await pl()).agent.state, "starting");
  await waitAgent("running");
  const r = rec();
  assert.deepEqual(r.argv, [], "no command-line arguments, so the secret can't show in `ps`");
  assert.equal(r.secretEnv, SECRET); assert.equal(r.plEnv, SECRET);
  const d = await pl();
  assert.ok(d.agent.logs.some((l) => l.includes("agent started, secret is ***")), "secret redacted in logs");
  assert.ok(!JSON.stringify(d).includes(SECRET));
  assert.equal((await call("PUT", "/api/playit/settings", { secret: "othersecret0123456789abcdef" })).status, 409, "locked while running");
  assert.equal((await call("POST", "/api/playit/start", {})).status, 200, "starting twice is harmless");
  assert.ok(alive(rec().pid));
  const pid = rec().pid;
  assert.equal((await call("POST", "/api/playit/stop", {})).status, 200);
  assert.equal((await pl()).agent.state, "idle");
  await waitFor(() => !alive(pid), 4000);
});

test("playit agent: without a secret the claim link is shown; a parent SECRET_KEY is not leaked to it", async () => {
  process.env.SECRET_KEY = "parentsecret_should_not_pass_0123456789";
  try {
    assert.equal((await call("PUT", "/api/playit/settings", { secret: "" })).status, 200);
    assert.equal((await pl()).secretSet, false);
    assert.equal((await call("POST", "/api/playit/start", {})).status, 200);
    await waitFor(async () => (await pl()).agent.claimUrl, 5000);
    assert.equal((await pl()).agent.claimUrl, "https://playit.gg/claim/abcd1234EFGH", "colour codes stripped, link found");
    assert.equal(rec().secretEnv, "");
  } finally { delete process.env.SECRET_KEY; await call("POST", "/api/playit/stop", {}); }
});

test("playit agent: rejected secret and later crash both end in an honest error with advice", async () => {
  await call("PUT", "/api/playit/settings", { secret: "badsecret0123456789abcdef" });
  await call("POST", "/api/playit/start", {});
  await waitAgent("error");
  let a = (await pl()).agent;
  assert.match(a.error, /stopped \(code 1\)/); assert.match(a.hint, /rejected the secret key/);
  await call("PUT", "/api/playit/settings", { secret: "crashy0123456789abcdef0123" });
  await call("POST", "/api/playit/start", {});
  await waitAgent("running");
  await waitAgent("error");
  a = (await pl()).agent;
  assert.match(a.error, /code 3/); assert.match(a.error, /no longer works/);
  await call("PUT", "/api/playit/settings", { secret: SECRET });
});

test("playit: not installed gives a clear refusal; missing program errors do not crash the panel", async () => {
  const none = new PlayitManager({ getSettings: () => ({}), candidates: ["/nonexistent/playit"] });
  assert.equal(await none.locate(), null);
  await assert.rejects(() => none.start(), /not installed/);
  const notExec = path.join(tmp, "not-exec"); fs.writeFileSync(notExec, "x", { mode: 0o644 });
  assert.equal(await new PlayitManager({ getSettings: () => ({}), candidates: [notExec] }).locate(), null, "a non-executable file is not 'installed'");
});

test("tunnel address is saved per server, validated, shown as the server's public address, and removed with the server", async () => {
  const a = await mkSrv("Pub A", 25565), b = await mkSrv("Pub B", 25611);
  const put = (serverId, address) => call("PUT", "/api/playit/address", { serverId, address });
  assert.equal((await put(a, "not an address")).status, 400);
  assert.equal((await put("nope", "x.craft.playit.gg")).status, 404);
  assert.equal((await getServer(a)).publicAddress, null);
  assert.equal((await put(a, "Alpha-Beta.craft.playit.gg")).status, 200);
  assert.equal((await put(b, "https://gamma.ply.gg:41234/")).status, 200);
  assert.equal((await getServer(a)).publicAddress, "alpha-beta.craft.playit.gg");
  assert.equal((await getServer(b)).publicAddress, "gamma.ply.gg:41234");
  assert.equal((await put(a, "")).status, 200);
  assert.equal((await getServer(a)).publicAddress, null);
  await call("DELETE", `/api/servers/${b}`);
  assert.equal((await pl()).addresses[b], undefined, "address removed with the server");
  await call("DELETE", `/api/servers/${a}`);
});

test("server-ip is kept blank; java gets the normal arguments; new servers write server-ip= and server-port", async () => {
  const sid = await mkSrv("Blank IP", 25565);
  const pf = path.join(tmp, "data", "servers", sid, "server.properties");
  const text = fs.readFileSync(pf, "utf8");
  assert.match(text, /^server-ip=$/m); assert.match(text, /^server-port=25565$/m);
  await call("PUT", `/api/servers/${sid}/upload?path=server.jar`, new Uint8Array([1]));
  fs.writeFileSync(pf, text.replace(/^server-ip=$/m, "server-ip=192.168.1.38"));
  assert.equal((await call("POST", `/api/servers/${sid}/start`, {})).status, 200);
  await waitStatus(sid, "running");
  assert.match(fs.readFileSync(pf, "utf8"), /^server-ip=$/m, "server-ip reset to blank");
  const argv = logsOf(sid).find((l) => l.startsWith("ARGV: ")).slice(6).split(" ");
  assert.deepEqual(argv, ["-Xmx512M", "-Xms256M", "-jar", "server.jar", "nogui"]);
  assert.equal((await call("PUT", `/api/servers/${sid}/properties`, { properties: { "server-ip": "10.0.0.1", "max-players": "7" } })).status, 200);
  const props = (await call("GET", `/api/servers/${sid}/properties`)).json.properties;
  assert.equal(props["server-ip"], ""); assert.equal(props["max-players"], "7");
  await call("POST", `/api/servers/${sid}/stop`, {}); await waitStatus(sid, "stopped");
  await call("DELETE", `/api/servers/${sid}`);
});

test("old ngrok and DuckDNS settings (and their tokens) are wiped from disk on start", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "app2-"));
  fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify({ ngrok: { authtoken: "oldngroktoken_1234567890" }, duckdns: { token: "oldducktoken-1234567890" }, users: [], sessions: [] }));
  const a2 = createApp2({ dataDir: dir, java: fakeJava, port: 0, host: "127.0.0.1", playit: { secret: "envsecret0123456789abcdef" }, playitPaths: [fakePlayit] });
  try {
    const raw = fs.readFileSync(path.join(dir, "db.json"), "utf8");
    assert.ok(!/ngrok|duckdns|oldngroktoken|oldducktoken/.test(raw), "old settings removed from db.json");
    assert.equal(a2.playit.getSettings().secret, "envsecret0123456789abcdef", ".env secret is the fallback");
    a2.store.data.playit.secret = "panelsecret0123456789abcdef";
    assert.equal(a2.playit.getSettings().secret, "panelsecret0123456789abcdef", "panel value wins");
  } finally { await a2.close(); }
});

test("ngrok and DuckDNS are gone from the project", () => {
  const root = path.join(import.meta.dirname, "..");
  const hits = [];
  const ok = /store\.data\[k\]|Those features are gone|older version|older versions|ngrok \/ DuckDNS|ngrok and DuckDNS|ngrok|duckdns/i;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", "data", ".git"].includes(e.name)) continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f !== import.meta.filename && (/ngrok|duck/i.test(e.name) || fs.readFileSync(f, "utf8").split("\n").some((l) => /ngrok|duckdns/i.test(l) && !/Older versions kept|for \(const k of \["ngrok"|older version|old ngrok/i.test(l)))) hits.push(path.relative(root, f)); } };
  walk(root);
  assert.deepEqual(hits, [], "no file mentions them (except the one cleanup line and the README note)");
});
