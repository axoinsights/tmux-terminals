#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error("tmux-terminals: dist/ is missing. In a git checkout run `npm install` (it builds) or `npm run build`.");
  process.exit(1);
}
await import(entry.href);
