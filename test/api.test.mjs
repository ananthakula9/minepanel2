import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  app = createApp({ dataDir: path.join(tmp, "data"), java: fakeJava, port: 0, host: "127.0.0.1" });
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
