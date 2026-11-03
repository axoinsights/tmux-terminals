#!/usr/bin/env node
/**
 * Server end to end without a browser: spawn a configured agent over an authenticated WebSocket, check the clean environment,
 * restart the server and confirm the session survives (tmux persistence), resume args, kill, and that only the test's own tmux socket is used.
 * Run: node test/e2e/persist.test.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT, cleanup, makeChecker, makeSandbox, sleep, startApp, tmux, until } from "./helpers.mjs";

const { WebSocket } = createRequire(path.join(ROOT, "package.json"))("ws");
const { state, check } = makeChecker();
const sb = makeSandbox("persist");
const agents = [
  { id: "shell", label: "Shell", command: "bash", args: ["--norc", "--noprofile", "-i"] },
  { id: "argv", label: "Argv", command: "sh", args: ["-c", 'echo "ARGV:[$*]"; exec cat', "_"], resumeArgs: ["--continue"] },
];
let app = null;

async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { Authorization: `Bearer ${sb.token}` } });
  const c = { ws, out: new Map(), list: null, spawned: null, errors: [], exits: [] };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "pty_output") c.out.set(m.sessionId, (c.out.get(m.sessionId) || "") + m.data);
    if (m.type === "pty_scrollback") c.out.set(m.sessionId, m.data);
    if (m.type === "pty_list") c.list = m.sessions;
    if (m.type === "pty_spawned") c.spawned = m.session;
    if (m.type === "pty_error") c.errors.push(m.message);
    if (m.type === "pty_exit") c.exits.push(m.sessionId);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  return c;
}
const spawnAgent = async (c, body) => { c.spawned = null; c.send({ type: "pty_spawn", cols: 100, rows: 30, cwd: sb.tmp, ...body }); await until(() => c.spawned || c.errors.length, 8000, "spawn"); return c.spawned; };

try {
  app = await startApp(sb, { agents });
  let c = await client();
  const s1 = await spawnAgent(c, { agent: "shell" });
  check("shell agent spawns in the requested directory", s1 && s1.cwd === sb.tmp && s1.agent === "shell", JSON.stringify(s1));
  await sleep(600);
  c.send({ type: "pty_input", sessionId: s1.id, data: 'echo "ENV[${TMUX_TERMINALS_TOKEN:-unset}|${TMUX_TERMINALS_PORT:-unset}]"; env | grep -c TMUX_TERMINALS_ | sed s/^/COUNT=/\r' });
  await until(() => /COUNT=\d/.test(c.out.get(s1.id) || ""), 8000, "env output");
  const out1 = c.out.get(s1.id);
  check("spawned process gets a clean env (no TMUX_TERMINALS_*)", out1.includes("ENV[unset|unset]") && out1.includes("COUNT=0"), JSON.stringify(out1.slice(-300)));
  c.send({ type: "pty_input", sessionId: s1.id, data: "echo PERSIST_$((20+22))\r" });
  await until(() => (c.out.get(s1.id) || "").includes("PERSIST_42"), 8000, "persist marker");

  const s2 = await spawnAgent(c, { agent: "argv", resume: true });
  await until(() => (c.out.get(s2.id) || "").includes("ARGV:[--continue]"), 8000, "resume args");
  check("resumeArgs are appended only when resume is requested", true);
  const s3 = await spawnAgent(c, { agent: "argv" });
  await until(() => (c.out.get(s3.id) || "").includes("ARGV:[]"), 8000, "plain args");
  check("a custom agent runs with its configured argv (no shell string)", true);
  const tmuxNames = tmux(sb.socket, "list-sessions", "-F", "#{session_name}").trim().split("\n");
  check("sessions live on the dedicated tmux socket as at-<uuid>", tmuxNames.length === 3 && tmuxNames.every((n) => /^at-[0-9a-f-]{36}$/.test(n)), tmuxNames.join(","));
  c.send({ type: "pty_rename", sessionId: s1.id, title: "my shell" });
  await until(() => c.list && c.list.find((s) => s.id === s1.id)?.title === "my shell", 5000, "rename");
  c.send({ type: "pty_order", order: [s3.id, s1.id, s2.id] });
  await until(() => c.list && c.list.map((s) => s.id).join() === [s3.id, s1.id, s2.id].join(), 5000, "order");
  c.ws.close();

  // ── restart the server: the agents must survive and be re-adopted ──
  await app.stop();
  check("agents keep running in tmux while the server is down", tmux(sb.socket, "list-sessions", "-F", "#{session_name}").trim().split("\n").length === 3);
  app.logs = "";
  await app.start();
  check("server logs the adoption", /adopted 3 running session/.test(app.logs), app.logs);
  c = await client();
  c.send({ type: "pty_list" });
  await until(() => c.list, 5000, "list after restart");
  check("all three sessions are listed after a restart, in the saved order, with the custom title",
    c.list.length === 3 && c.list.map((s) => s.id).join() === [s3.id, s1.id, s2.id].join() && c.list.find((s) => s.id === s1.id).title === "my shell" && c.list.find((s) => s.id === s1.id).agent === "shell",
    JSON.stringify(c.list.map((s) => [s.id.slice(0, 4), s.title, s.agent])));
  c.send({ type: "pty_attach", sessionId: s1.id });
  await until(() => (c.out.get(s1.id) || "").includes("PERSIST_42"), 8000, "scrollback after restart");
  check("scrollback shows what happened before the restart", true);
  c.send({ type: "pty_input", sessionId: s1.id, data: "echo AFTER_$((1+1))\r" });
  await until(() => (c.out.get(s1.id) || "").includes("AFTER_2"), 8000, "typing after restart");
  check("typing into an adopted session works", true);

  // ── kill ends the tmux session; the others stay ──
  c.send({ type: "pty_kill", sessionId: s3.id });
  await until(() => c.list && c.list.find((s) => s.id === s3.id)?.status === "exited", 8000, "exited tombstone");
  const left = tmux(sb.socket, "list-sessions", "-F", "#{session_name}").trim().split("\n");
  check("kill removes only that tmux session and tombstones it for clients", left.length === 2 && !left.includes("at-" + s3.id));
  c.ws.close();
} catch (e) {
  state.fail++;
  console.log("FAIL exception", e?.stack || e);
  console.log((app?.logs || "").slice(-2000));
} finally {
  if (app) await app.stop();
  cleanup(sb);
}
console.log(`\n${state.pass}/${state.pass + state.fail} passed`);
process.exit(state.fail ? 1 : 0);
