// Shared harness for the Playwright suites: every test gets its own random port, config dir and tmux socket,
// and cleans up only what it started (kills its own process group by PID, `tmux -L <its socket> kill-server`).
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = path.join(ROOT, "bin", "tmux-terminals.mjs");
export const TMUX_CONF = path.join(ROOT, "tmux.conf");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loadPlaywright() {
  const m = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  return m.chromium ? m : m.default;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export function makeChecker() {
  const state = { pass: 0, fail: 0 };
  const check = (name, ok, info = "") => {
    ok ? state.pass++ : state.fail++;
    console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + String(info).slice(0, 600)));
  };
  return { state, check };
}

export async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); }
  throw new Error("timeout waiting for " + what);
}

export const tmux = (sock, ...a) => execFileSync("tmux", ["-L", sock, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Private sandbox: temp dir, unique tmux socket names, random token. */
export function makeSandbox(tag) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `at-${tag}-`)));
  const suffix = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  return {
    tmp,
    socket: `at-test-${tag}-${suffix}`,
    groupSocket: `at-test-${tag}-grp-${suffix}`,
    token: crypto.randomBytes(18).toString("base64url"),
    configDir: path.join(tmp, "config"),
  };
}

export async function startApp(sb, { port, groups, agents, pathPrepend, extraEnv = {} } = {}) {
  port = port ?? (await freePort());
  const env = {
    ...process.env,
    ...(pathPrepend ? { PATH: `${pathPrepend}:${process.env.PATH}` } : {}),
    TMUX_TERMINALS_CONFIG_DIR: sb.configDir,
    TMUX_TERMINALS_PORT: String(port),
    TMUX_TERMINALS_HOST: "127.0.0.1",
    TMUX_TERMINALS_TOKEN: sb.token,
    TMUX_TERMINALS_TMUX_SOCKET: sb.socket,
    TMUX_TERMINALS_GROUP_POLL_MS: "400",
    ...(groups ? { TMUX_TERMINALS_GROUPS: JSON.stringify(groups) } : {}),
    ...(agents ? { TMUX_TERMINALS_AGENTS: JSON.stringify(agents) } : {}),
    ...extraEnv,
  };
  const app = { port, logs: "", proc: null, sb, base: `http://127.0.0.1:${port}` };
  app.url = (q = "") => `${app.base}/?token=${sb.token}${q}`;
  app.start = async () => {
    app.proc = spawn(process.execPath, [BIN, "start"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: sb.tmp });
    const on = (d) => { app.logs += d; if (process.env.E2E_VERBOSE) process.stdout.write("  [app] " + d); };
    app.proc.stdout.on("data", on); app.proc.stderr.on("data", on);
    await until(() => /listening on/.test(app.logs) || app.proc.exitCode !== null, 30000, "server up");
    if (app.proc.exitCode !== null) throw new Error("server exited early:\n" + app.logs);
  };
  app.stop = async () => {
    if (!app.proc) return;
    try { process.kill(-app.proc.pid, "SIGTERM"); } catch { /* gone */ }
    const t0 = Date.now();
    while (app.proc.exitCode === null && app.proc.signalCode === null && Date.now() - t0 < 6000) await sleep(50);
    app.proc = null;
  };
  await app.start();
  return app;
}

/** Kill only this sandbox's tmux servers and remove its temp dir. */
export function cleanup(sb, extraSockets = []) {
  for (const s of [sb.socket, sb.groupSocket, ...extraSockets]) {
    try { tmux(s, "kill-server"); } catch { /* none running */ }
    // kill-server can leave the (dead) socket file behind: remove only our own test socket
    if (s.startsWith("at-test-")) { try { fs.rmSync(path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid()}`, s), { force: true }); } catch { /* ignore */ } }
  }
  fs.rmSync(sb.tmp, { recursive: true, force: true });
}

/** A sandbox with one pre-existing bash session (prompt `PROMPT$ `) that the server adopts at start-up. */
export async function shellSandbox(tag) {
  const sb = makeSandbox(tag);
  fs.mkdirSync(sb.configDir, { recursive: true, mode: 0o700 });
  const sid = crypto.randomUUID();
  tmux(sb.socket, "-f", TMUX_CONF, "start-server");
  tmux(sb.socket, "-f", TMUX_CONF, "new-session", "-d", "-s", "at-" + sid, "-x", "80", "-y", "24", "-c", sb.tmp, "env", "PS1=PROMPT$ ", "bash", "--norc", "--noprofile", "-i");
  fs.writeFileSync(path.join(sb.configDir, "sessions.json"), JSON.stringify([{ id: sid, agent: "shell", cwd: sb.tmp, title: "shell", titleCustom: true, startedAt: Date.now() }]));
  const app = await startApp(sb);
  return {
    sb, sid, app, socket: sb.socket,
    pane: () => tmux(sb.socket, "capture-pane", "-p", "-t", "=at-" + sid + ":"),
    cleanup: async () => { await app.stop(); cleanup(sb); },
  };
}
