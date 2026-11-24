// Strict confinement of file operations to a server's root directory.
import fs from "node:fs";
import path from "node:path";

export class PathError extends Error {}

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// Resolves `rel` under `root`. Throws PathError on any escape attempt.
// Works for paths that do not exist yet (create/upload) by checking the deepest existing ancestor.
export function safeResolve(root, rel) {
  if (typeof rel !== "string" || rel.includes("\0")) throw new PathError("invalid path");
  const rootReal = fs.realpathSync(root);
  const cleaned = rel.replace(/^[/\\]+/, "");
  const target = path.resolve(rootReal, cleaned);
  if (!inside(rootReal, target)) throw new PathError("path escapes server directory");

  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeReal = fs.realpathSync(probe);
  if (!inside(rootReal, probeReal)) throw new PathError("symlink escapes server directory");
  return target;
}

// Server ids become directory names, so they are restricted to a safe charset.
export function validateServerId(id) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new PathError("invalid server id");
  return id;
}
