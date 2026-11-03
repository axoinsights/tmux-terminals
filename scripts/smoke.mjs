#!/usr/bin/env node
// End-to-end smoke test against a RUNNING server: authenticated WebSocket, spawn the `shell` agent, echo a marker,
// kill the session. Usage: node scripts/smoke.mjs <base-url> [agent=shell]   (token from AGENT_TERMINAL_TOKEN or `agent-terminal token`)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { WebSocket } = createRequire(path.join(root, "package.json"))("ws");
const base = process.argv[2] || "http://127.0.0.1:8767";
const agent = process.argv[3] || "shell";
const token = process.env.AGENT_TERMINAL_TOKEN || execFileSync(process.execPath, [path.join(root, "bin", "agent-terminal.mjs"), "token"], { encoding: "utf8" }).trim();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed certificate on --host 0.0.0.0

const health = await fetch(`${base}/healthz`).then((r) => r.json());
if (!health.ok) throw new Error("healthz not ok");
const unauth = await fetch(`${base}/api/config`);
if (unauth.status !== 401) throw new Error(`expected 401 without a token, got ${unauth.status}`);

const marker = `AT_SMOKE_${Math.random().toString(36).slice(2, 10)}`;
const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { Authorization: `Bearer ${token}` } });
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for the echoed marker")), 15000);
  let sid = null, buf = "", sent = false;
  ws.on("error", reject);
  ws.on("open", () => ws.send(JSON.stringify({ type: "pty_spawn", agent, cwd: "~", cols: 100, rows: 30 })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "pty_error") reject(new Error(m.message));
    if (m.type === "pty_spawned") { sid = m.session.id; setTimeout(() => { sent = true; ws.send(JSON.stringify({ type: "pty_input", sessionId: sid, data: `echo ${marker.slice(0, 8)}''${marker.slice(8)}\r` })); }, 800); }
    if (m.type === "pty_output" && sent) {
      buf += m.data;
      if (buf.includes(marker)) { clearTimeout(timer); ws.send(JSON.stringify({ type: "pty_kill", sessionId: sid })); setTimeout(() => resolve(marker), 300); }
    }
  });
});
ws.close();
console.log(`smoke ok: version ${health.version}, unauthenticated request refused, shell echoed ${result}`);
process.exit(0);
