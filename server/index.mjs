import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8080);
const app = createApp({
  dataDir: process.env.DATA_DIR || path.join(root, "data"),
  java: process.env.JAVA || "java",
  port,
  host: process.env.HOST || "0.0.0.0",
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
