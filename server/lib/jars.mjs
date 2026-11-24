// Version lists and server jar downloads from Mojang and PaperMC only.
// NOTE: these call the live APIs, so they need internet on the host device.
import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const UA = { "user-agent": "MinePanel/0.2 (self-hosted panel)" };
const ALLOWED_HOST = /(^|\.)(mojang\.com|papermc\.io)$/;
const VERSION_RE = /^[0-9A-Za-z._-]{1,30}$/;

export const validVersion = (v) => typeof v === "string" && VERSION_RE.test(v);

async function getJson(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOST.test(u.hostname)) throw new Error("blocked host");
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${u.hostname} returned ${res.status}`);
  return res.json();
}

export async function listVersions(type) {
  if (type === "vanilla") {
    const m = await getJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    return m.versions.filter((v) => v.type === "release").map((v) => v.id).slice(0, 40);
  }
  if (type === "paper") {
    const p = await getJson("https://fill.papermc.io/v3/projects/paper");
    const groups = p.versions || {};
    const all = Array.isArray(groups) ? groups : Object.values(groups).flat();
    return all.slice(0, 40);
  }
  throw new Error("unknown type");
}

async function resolveDownload(type, version) {
  if (type === "vanilla") {
    const m = await getJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    const v = m.versions.find((x) => x.id === version);
    if (!v) throw new Error("unknown Minecraft version");
    const meta = await getJson(v.url);
    const d = meta.downloads?.server;
    if (!d) throw new Error("this version has no server download");
    return { url: d.url, algo: "sha1", hash: d.sha1 };
  }
  const b = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds/latest`);
  const d = b.downloads?.["server:default"];
  if (!d) throw new Error("no Paper build found for this version");
  return { url: d.url, algo: "sha256", hash: d.checksums?.sha256 };
}

export async function downloadJar(type, version, dest) {
  const { url, algo, hash } = await resolveDownload(type, version);
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOST.test(u.hostname)) throw new Error("blocked download host");
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  if (!ALLOWED_HOST.test(new URL(res.url).hostname)) throw new Error("download redirected to a blocked host");
  const h = crypto.createHash(algo);
  const tmp = dest + ".part";
  const out = fs.createWriteStream(tmp);
  const src = Readable.fromWeb(res.body);
  src.on("data", (c) => h.update(c));
  await pipeline(src, out);
  if (hash && h.digest("hex") !== hash) { fs.rmSync(tmp, { force: true }); throw new Error("checksum mismatch, download discarded"); }
  fs.renameSync(tmp, dest);
}
