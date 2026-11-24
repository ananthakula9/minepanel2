// File operations confined to one server directory. Every path goes through safeResolve.
import fs from "node:fs";
import path from "node:path";
import { safeResolve, PathError } from "./paths.mjs";

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

export function list(root, rel) {
  const dir = safeResolve(root, rel);
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new PathError("not a directory");
  return fs.readdirSync(dir, { withFileTypes: true })
    .map((d) => {
      let size = 0, mtime = 0;
      try { const s = fs.statSync(path.join(dir, d.name)); size = s.size; mtime = s.mtimeMs; } catch {}
      return { name: d.name, type: d.isDirectory() ? "dir" : "file", size: d.isDirectory() ? null : size, mtime };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

export function readText(root, rel) {
  const f = safeResolve(root, rel);
  const st = fs.statSync(f);
  if (!st.isFile()) throw new PathError("not a file");
  if (st.size > MAX_EDIT_BYTES) throw new PathError("file too large to edit (limit 2 MB)");
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) throw new PathError("binary file, download it instead");
  return buf.toString("utf8");
}

export function writeText(root, rel, content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new PathError("content too large");
  const f = safeResolve(root, rel);
  if (f === fs.realpathSync(root)) throw new PathError("invalid path");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

export function mkdir(root, rel) {
  const d = safeResolve(root, rel);
  fs.mkdirSync(d, { recursive: true });
}

function notRoot(root, target) {
  if (target === fs.realpathSync(root)) throw new PathError("cannot modify the server root");
}

export function rename(root, from, to) {
  const a = safeResolve(root, from), b = safeResolve(root, to);
  notRoot(root, a); notRoot(root, b);
  if (fs.existsSync(b)) throw new PathError("destination already exists");
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
}

export function remove(root, rel) {
  const f = safeResolve(root, rel);
  notRoot(root, f);
  fs.rmSync(f, { recursive: true, force: false });
}

export function resolveForStream(root, rel) {
  return safeResolve(root, rel);
}

// server.properties helpers: keep comments and order, change only requested keys.
export function parseProps(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export function updateProps(text, updates) {
  const lines = text.split(/\r?\n/);
  const done = new Set();
  const next = lines.map((line) => {
    const i = line.indexOf("=");
    if (!line.startsWith("#") && i > 0) {
      const k = line.slice(0, i);
      if (k in updates) { done.add(k); return `${k}=${updates[k]}`; }
    }
    return line;
  });
  while (next.length && next[next.length - 1] === "") next.pop();
  for (const k of Object.keys(updates)) if (!done.has(k)) next.push(`${k}=${updates[k]}`);
  return next.join("\n") + "\n";
}
