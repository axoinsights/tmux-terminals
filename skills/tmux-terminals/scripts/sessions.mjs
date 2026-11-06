#!/usr/bin/env node
/**
 * List the tmux-terminals sessions of a running server (read-only).
 *
 * The token is read from the config file or TMUX_TERMINALS_TOKEN, never taken from argv,
 * so it cannot leak into shell history or `ps`.
 *
 * Usage: node sessions.mjs [--url http://127.0.0.1:8767] [--json] [--insecure]
 * Base URL resolution: --url > TMUX_TERMINALS_HOST/PORT > config.json > defaults. Start flags are
 * per invocation, so if you started with `--port 8800`, pass `--url http://127.0.0.1:8800`.
 * Exit:  0 sessions listed (even an empty list), 1 could not talk to the server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

if (flag("help") || args[0] === "-h") {
  console.log("usage: sessions.mjs [--url http://host:port] [--config-dir DIR] [--json] [--insecure]");
  process.exit(0);
}

const configDir =
  opt("config-dir") ||
  process.env.TMUX_TERMINALS_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tmux-terminals");

let config = {};
const configFile = path.join(configDir, "config.json");
try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch {
  // No config file: fall back to defaults, the token may still come from the environment.
}

const token = process.env.TMUX_TERMINALS_TOKEN || config.token;
if (!token) {
  console.error(`no access token: start the server once, or set TMUX_TERMINALS_TOKEN (config: ${configFile})`);
  process.exit(1);
}

const host = process.env.TMUX_TERMINALS_HOST || config.host || "127.0.0.1";
const port = process.env.TMUX_TERMINALS_PORT || config.port || 8767;
const url = new URL(opt("url") || `http://${host}:${port}`);
if (url.protocol === "https:" && flag("insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const health = await fetch(new URL("/healthz", url)).then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`nothing answering at ${url.origin} — is it running (tmux-terminals status --json), and did you start it on another port (--url http://${host}:${port})?`);
  process.exit(1);
}

const res = await fetch(new URL("/api/sessions", url), { headers: { Authorization: `Bearer ${token}` } });
if (res.status === 401) {
  console.error("401 unauthorized: the token does not match the server's (tmux-terminals token --url)");
  process.exit(1);
}
if (!res.ok) {
  console.error(`${res.status} ${await res.text().catch(() => "")}`);
  process.exit(1);
}
const { sessions } = await res.json();

if (flag("json")) {
  console.log(JSON.stringify({ ok: true, version: health.version, url: url.origin, sessions }, null, 2));
  process.exit(0);
}

const age = (s) => {
  const seconds = Math.round((Date.now() - (s.lastOutputAt || s.startedAt)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

console.log(`tmux-terminals ${health.version} at ${url.origin} — ${sessions.length} session(s)`);
for (const s of sessions) {
  const state = s.status === "running" ? "running" : `exited(${s.exitCode ?? "?"})`;
  console.log(`  ${s.id}  ${(s.group ? `${s.group}/` : "") + s.agent}  ${state}  idle ${age(s)}  ${s.title || "(untitled)"}  [${s.cwd}]`);
}
if (!sessions.length) console.log("  (none yet — start one from the phone UI or with pty_spawn)");
