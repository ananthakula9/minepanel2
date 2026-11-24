// Password hashing (scrypt, built in) and session handling.
import crypto from "node:crypto";

const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  store.data.sessions = store.data.sessions.filter((s) => s.expires > now);
  store.data.sessions.push({ hash: sha256(token), userId, expires: now + SESSION_MS });
  store.save();
  return { token, maxAgeSec: SESSION_MS / 1000 };
}

export function findSession(store, token) {
  if (!token) return null;
  const h = sha256(token);
  const s = store.data.sessions.find((x) => x.hash === h && x.expires > Date.now());
  return s ? store.data.users.find((u) => u.id === s.userId) || null : null;
}

export function destroySession(store, token) {
  if (!token) return;
  const h = sha256(token);
  store.data.sessions = store.data.sessions.filter((s) => s.hash !== h);
  store.save();
}

// Simple in-memory brute-force limiter: 5 failures per IP -> 60 s lock.
export class LoginLimiter {
  constructor() { this.fails = new Map(); }
  blocked(ip) { const f = this.fails.get(ip); return !!f && f.count >= 5 && Date.now() < f.until; }
  fail(ip) {
    const f = this.fails.get(ip) || { count: 0, until: 0 };
    f.count += 1; f.until = Date.now() + 60_000; this.fails.set(ip, f);
  }
  ok(ip) { this.fails.delete(ip); }
}
