// tar.gz backups using the system `tar` (arguments are passed as an array, never through a shell).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const BACKUP_RE = /^backup-\d{8}-\d{6}\.tar\.gz$/;
export const MAX_BACKUPS = 10;

export class BackupError extends Error {}

function tar(args, { okCodes = [0], collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn("tar", args, { stdio: ["ignore", collect ? "pipe" : "ignore", "pipe"] });
    let out = "", err = "";
    c.stdout?.on("data", (d) => { if (out.length < 8_000_000) out += d; });
    c.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
    c.on("error", (e) => reject(new BackupError(e.code === "ENOENT" ? "tar is not installed. In Termux run: pkg install tar" : e.message)));
    c.on("close", (code) => (okCodes.includes(code) ? resolve(out) : reject(new BackupError(err.trim().split("\n")[0] || `tar failed (code ${code})`))));
  });
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => BACKUP_RE.test(n)).map((name) => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function createBackup(serverRoot, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (listBackups(dir).length >= MAX_BACKUPS) throw new BackupError(`Limit of ${MAX_BACKUPS} backups reached. Delete an old one first.`);
  const final = path.join(dir, `backup-${stamp()}.tar.gz`);
  if (fs.existsSync(final)) throw new BackupError("A backup was just made. Wait a few seconds and try again.");
  const tmp = final + ".part";
  try {
    // exit code 1 means "a file changed while reading", which is normal for a live server; the archive is still usable
    await tar(["-czf", tmp, "-C", serverRoot, "."], { okCodes: [0, 1] });
    fs.renameSync(tmp, final);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  return path.basename(final);
}

export async function restoreBackup(file, serversDir, id) {
  // 1. Inspect before extracting: no absolute paths, no "..", no links or device files.
  const names = (await tar(["-tzf", file], { collect: true })).split("\n").filter(Boolean);
  if (!names.length) throw new BackupError("Backup is empty");
  for (const n of names) {
    if (n.startsWith("/") || n.split("/").includes("..")) throw new BackupError("Backup contains unsafe paths, refusing to restore");
  }
  const types = (await tar(["-tvzf", file], { collect: true })).split("\n").filter(Boolean).map((l) => l[0]);
  if (types.some((t) => !["-", "d"].includes(t))) throw new BackupError("Backup contains links or special files, refusing to restore");

  // 2. Extract next to the server, then swap, so a failed restore never destroys the current server.
  const root = path.join(serversDir, id);
  const tmp = path.join(serversDir, `.restore-${id}-${Date.now()}`);
  const old = path.join(serversDir, `.old-${id}-${Date.now()}`);
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    await tar(["-xzf", file, "-C", tmp, "--no-same-owner"]);
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  try {
    fs.renameSync(root, old);
    try { fs.renameSync(tmp, root); }
    catch (e) { fs.renameSync(old, root); throw e; }
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw new BackupError(`Restore failed: ${e.message}`); }
  fs.rmSync(old, { recursive: true, force: true });
}

// Total size of a directory without following symlinks.
export function dirSize(root, maxEntries = 200_000) {
  let total = 0, seen = 0;
  const stack = [root];
  while (stack.length && seen < maxEntries) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch {} }
    }
  }
  return total;
}
