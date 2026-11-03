// Runs on `npm install` in a git checkout: compile TypeScript into dist/.
// Skipped when typescript is not installed (installing the published tarball: dist/ is already inside it).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
if (!existsSync(tsc)) {
  if (!existsSync(path.join(root, "dist", "cli.js"))) console.warn("tmux-terminals: typescript not installed and dist/ missing; run `npm install` with devDependencies.");
  process.exit(0);
}
const r = spawnSync(tsc, [], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
