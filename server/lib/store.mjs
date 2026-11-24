// Tiny JSON-file database with atomic writes. Everything stays on the device.
import fs from "node:fs";
import path from "node:path";

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "db.json");
    this.data = { users: [], sessions: [], servers: [] };
    if (fs.existsSync(this.file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
