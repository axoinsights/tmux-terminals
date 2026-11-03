#!/usr/bin/env node
// Runs every test/e2e/*.test.mjs in sequence (each is its own process with its own port, config dir and tmux socket).
// Playwright is loaded from the `playwright` package, or from PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs.
// Browser-free suites always run; Playwright suites are skipped with a clear message if Playwright is unavailable
// (set REQUIRE_PLAYWRIGHT=1, as CI does, to make that a failure).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2e");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

let havePlaywright = true;
try { await import(process.env.PLAYWRIGHT_MODULE || "playwright"); } catch { havePlaywright = false; }

const results = [];
for (const f of files) {
  const needsBrowser = /loadPlaywright/.test((await import("node:fs")).readFileSync(path.join(dir, f), "utf8"));
  if (needsBrowser && !havePlaywright) {
    const required = process.env.REQUIRE_PLAYWRIGHT === "1";
    console.log(`\n=== ${f}: ${required ? "FAIL" : "SKIPPED"} (Playwright not found; npm i -D playwright && npx playwright install chromium, or set PLAYWRIGHT_MODULE)`);
    results.push([f, required ? "fail" : "skip"]);
    continue;
  }
  console.log(`\n=== ${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit", env: process.env });
  results.push([f, r.status === 0 ? "pass" : "fail"]);
}
console.log("\n--- e2e summary ---");
for (const [f, s] of results) console.log(`${s.toUpperCase().padEnd(5)} ${f}`);
process.exit(results.some(([, s]) => s === "fail") ? 1 : 0);
