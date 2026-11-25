// Player lists (ops, whitelist, bans) are read from the server's own JSON files.
// Changes are made only by sending vanilla console commands, so Minecraft itself keeps the files correct.
import fs from "node:fs";
import path from "node:path";

export const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

function readList(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.filter((e) => e && typeof e.name === "string") : [];
  } catch { return []; }
}
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

export function readLists(root) {
  return {
    ops: readList(path.join(root, "ops.json")).map((e) => ({ name: e.name.slice(0, 32), uuid: str(e.uuid, 40), level: Number.isInteger(e.level) ? e.level : null })),
    whitelist: readList(path.join(root, "whitelist.json")).map((e) => ({ name: e.name.slice(0, 32), uuid: str(e.uuid, 40) })),
    banned: readList(path.join(root, "banned-players.json")).map((e) => ({ name: e.name.slice(0, 32), uuid: str(e.uuid, 40), reason: str(e.reason, 200) })),
  };
}

// Returns the exact console command, or throws Error with a message fit for the user.
export function buildCommand(action, name, reason) {
  if (action === "whitelist-on") return "whitelist on";
  if (action === "whitelist-off") return "whitelist off";
  if (typeof name !== "string" || !NAME_RE.test(name)) throw new Error("Player name must be 1–16 letters, numbers or underscores");
  const why = typeof reason === "string" ? reason.replace(/[\r\n\0]+/g, " ").trim().slice(0, 100) : "";
  switch (action) {
    case "op": return `op ${name}`;
    case "deop": return `deop ${name}`;
    case "whitelist-add": return `whitelist add ${name}`;
    case "whitelist-remove": return `whitelist remove ${name}`;
    case "ban": return why ? `ban ${name} ${why}` : `ban ${name}`;
    case "pardon": return `pardon ${name}`;
    case "kick": return why ? `kick ${name} ${why}` : `kick ${name}`;
    default: throw new Error("Unknown action");
  }
}
