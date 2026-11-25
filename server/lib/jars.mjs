// Version lists and downloads from Mojang, PaperMC and Modrinth only.
// NOTE: these call the live APIs, so they need internet on the host device.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const UA = { "user-agent": "MinePanel/0.3 (self-hosted panel)" };
const SERVER_HOSTS = /(^|\.)(mojang\.com|papermc\.io)$/;
const MODRINTH_HOSTS = /^(api|cdn)\.modrinth\.com$/;
const VERSION_RE = /^[0-9A-Za-z._-]{1,30}$/;


export const validVersion = (v) => typeof v === "string" && VERSION_RE.test(v);

async function getJson(url, hosts = SERVER_HOSTS) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !hosts.test(u.hostname)) throw new Error("blocked host");
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${u.hostname} returned ${res.status}`);
  return res.json();
}

async function downloadVerified(url, algo, hash, dest, hosts) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !hosts.test(u.hostname)) throw new Error("blocked download host");
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  if (!hosts.test(new URL(res.url).hostname)) throw new Error("download redirected to a blocked host");
  const h = crypto.createHash(algo);
  const tmp = dest + ".part";
  const src = Readable.fromWeb(res.body);
  src.on("data", (c) => h.update(c));
  await pipeline(src, fs.createWriteStream(tmp));
  if (hash && h.digest("hex") !== hash) { fs.rmSync(tmp, { force: true }); throw new Error("checksum mismatch, download discarded"); }
  fs.renameSync(tmp, dest);
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
  await downloadVerified(url, algo, hash, dest, SERVER_HOSTS);
}

const LOADERS = ["paper", "spigot", "bukkit"];
const SLUG_RE = /^[A-Za-z0-9_-]{2,64}$/;
export const validProject = (v) => typeof v === "string" && SLUG_RE.test(v);

// Searches Modrinth for plugins (Paper/Spigot/Bukkit/Purpur). Filters by Minecraft version when known.
export async function searchPlugins(query, gameVersion) {
  const facets = [["categories:paper", "categories:spigot", "categories:bukkit", "categories:purpur"]];
  if (validVersion(gameVersion)) facets.push([`versions:${gameVersion}`]);
  const q = new URLSearchParams({ query: String(query).slice(0, 60), limit: "15", facets: JSON.stringify(facets) });
  const r = await getJson(`https://api.modrinth.com/v2/search?${q}`, MODRINTH_HOSTS);
  return (r.hits || []).map((h) => ({
    id: String(h.project_id || "").slice(0, 20), slug: String(h.slug || "").slice(0, 64), title: String(h.title || "").slice(0, 80),
    description: String(h.description || "").slice(0, 200), downloads: Number(h.downloads) || 0, author: String(h.author || "").slice(0, 40),
  })).filter((h) => validProject(h.id));
}

// Installs the newest compatible release of a Modrinth project into destDir.
// Only .jar files from cdn.modrinth.com are accepted, and the SHA-512 is verified.
export async function installPlugin(project, gameVersion, destDir) {
  if (!validProject(project)) throw new Error("Invalid plugin id");
  const q = new URLSearchParams({ loaders: JSON.stringify(LOADERS) });
  if (validVersion(gameVersion)) q.set("game_versions", JSON.stringify([gameVersion]));
  const versions = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(project)}/version?${q}`, MODRINTH_HOSTS);
  if (!Array.isArray(versions) || !versions.length)
    throw new Error(validVersion(gameVersion) ? `No build found for Minecraft ${gameVersion}` : "No compatible build found");
  const v = versions.find((x) => x.version_type === "release") || versions[0];
  const file = v.files?.find((f) => f.primary) || v.files?.[0];
  if (!file || !/^[A-Za-z0-9._-]{1,100}\.jar$/.test(file.filename || "")) throw new Error("Unexpected file in Modrinth response");
  if (!file.hashes?.sha512) throw new Error("Modrinth gave no checksum, refusing to install");
  fs.mkdirSync(destDir, { recursive: true });
  await downloadVerified(file.url, "sha512", file.hashes.sha512, path.join(destDir, file.filename), MODRINTH_HOSTS);
  const requires = (v.dependencies || []).filter((d) => d.dependency_type === "required" && validProject(d.project_id)).map((d) => d.project_id);
  return { filename: file.filename, version: String(v.version_number || ""), requires };
}
