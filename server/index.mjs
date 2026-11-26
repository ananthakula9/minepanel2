import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createApp } from "./app.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader (no packages). Real environment variables win over the file.
try {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const v = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch {}
const port = Number(process.env.PORT || 8080);
const app = createApp({
  dataDir: process.env.DATA_DIR || path.join(root, "data"),
  java: process.env.JAVA || "java",
  port,
  host: process.env.HOST || "0.0.0.0",
  playit: { secret: process.env.PLAYIT_SECRET || undefined },
});

await app.listen();
console.log(`MinePanel is running.\n  On this device: http://localhost:${port}`);
try {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) console.log(`  On your Wi-Fi:  http://${a.address}:${port}`);
} catch { console.log("  (Could not detect Wi-Fi address. Run `ifconfig` or check your phone's Wi-Fi settings.)"); }
console.log("Keep this running. Press Ctrl+C to stop (running Minecraft servers are stopped safely first).");

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
  if (closing) return; closing = true;
  console.log("\nStopping servers and shutting down...");
  await app.close(); process.exit(0);
});
