/** agent-terminal CLI: start | doctor | token | install-service | stop | status | --help */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigError, isLoopback, loadConfig, which, type Flags, type LoadedConfig } from "./config.js";
import { formatReport, runDoctor } from "./doctor.js";
import { baseUrls, effectiveScheme, pairingUrls, qrText } from "./pairing.js";
import { installService } from "./service.js";
import { startServer } from "./server.js";
import { runSmoke } from "./smoke.js";
import { ensureSelfSigned } from "./tls.js";
import { readVersion } from "./version.js";

const HELP = `agent-terminal ${readVersion()} - web terminal for coding agents running in tmux

Usage:
  agent-terminal [start] [options]    Start the server (foreground)
  agent-terminal start --daemon       Start in the background (pid + log in the state dir)
  agent-terminal stop                 Stop a --daemon instance (agent sessions keep running in tmux)
  agent-terminal status               Show whether it is running
  agent-terminal doctor [--json]      Check node, tmux, node-pty, config, port, TLS; exit 1 on problems
  agent-terminal token [--url|--qr]   Print the access token (or pairing URL / QR code)
  agent-terminal smoke [--json]       Test a running server end to end (auth, WebSocket, shell echo)
  agent-terminal install-service      Write a systemd user unit (Linux) or launchd agent (macOS); prints how to enable it
  agent-terminal --help | --version

Options (flags > AGENT_TERMINAL_* env vars > config.json):
  --host <addr>          Bind address (default 127.0.0.1; use 0.0.0.0 to serve your LAN, with TLS)
  --port <n>             Port (default 8767)
  --tls <auto|off|cert.pem,key.pem>
                         auto = self-signed certificate when the host is not loopback (default)
  --tmux-socket <name>   Dedicated tmux socket name (default agent-terminal; "default" is refused)
  --config-dir <dir>     Config directory (default ~/.config/agent-terminal)
  --json                 doctor/token/status: machine-readable output
  --show-token           Print the pairing URL + QR at startup even on a non-TTY / not first run
  --dry-run, --force     install-service: print only / overwrite an existing unit

Config: ${"~/.config/agent-terminal/config.json"} (created on first run, mode 600). Docs: README.md
`;

const OPTIONS = {
  host: { type: "string" },
  port: { type: "string" },
  tls: { type: "string" },
  "tmux-socket": { type: "string" },
  "config-dir": { type: "string" },
  json: { type: "boolean" },
  url: { type: "boolean" },
  qr: { type: "boolean" },
  daemon: { type: "boolean" },
  "show-token": { type: "boolean" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-terminal.mjs");

function fail(msg: string, code = 1): never {
  console.error(`agent-terminal: ${msg}`);
  process.exit(code);
}

function exposureHelp(loaded: LoadedConfig): string[] {
  const { host, port } = loaded.config;
  if (!isLoopback(host)) return [];
  return [
    "Listening on loopback only. To reach it from your phone:",
    `  - Tailscale (HTTPS, no cert warnings):  tailscale serve --bg --https=443 http://127.0.0.1:${port}`,
    "  - Same Wi-Fi / LAN:                      agent-terminal --host 0.0.0.0   (auto self-signed TLS; accept the browser warning once)",
  ];
}

function pid(file: string): number | null {
  try { const n = Number(fs.readFileSync(file, "utf8").trim()); return n > 1 ? n : null; } catch { return null; }
}
function alive(p: number): boolean {
  try { process.kill(p, 0); return true; } catch { return false; }
}

async function cmdStart(flags: Flags, v: Record<string, unknown>): Promise<void> {
  const loaded = loadConfig({ flags });
  const { config } = loaded;
  if (!which("tmux")) fail("tmux is not installed. Install it (apt-get install -y tmux | dnf install tmux | brew install tmux), then run `agent-terminal doctor`.");

  if (v.daemon) {
    const file = path.join(loaded.stateDir, "agent-terminal.pid");
    const old = pid(file);
    if (old && alive(old)) fail(`already running (pid ${old}); stop it with \`agent-terminal stop\``);
    fs.mkdirSync(loaded.stateDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(loaded.stateDir, "agent-terminal.log");
    const log = fs.openSync(logFile, "a", 0o600);
    const args = [SCRIPT, "start"];
    for (const k of ["host", "port", "tls", "tmux-socket", "config-dir"] as const) if (flags[k] !== undefined) args.push(`--${k}`, String(flags[k]));
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
    fs.writeFileSync(file, String(child.pid), { mode: 0o600 });
    const scheme = effectiveScheme(config);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!alive(child.pid!)) fail(`the background process exited; see ${logFile}`);
      const { default: h } = await import(scheme === "https" ? "node:https" : "node:http");
      const ok = await new Promise<boolean>((resolve) => {
        const req = h.get({ host: config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host, port: config.port, path: "/healthz", rejectUnauthorized: false, timeout: 1000 }, (res: import("node:http").IncomingMessage) => { res.resume(); resolve(res.statusCode === 200); });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ok) {
        console.log(`agent-terminal running in the background (pid ${child.pid}), ${baseUrls(config)[0]}`);
        console.log(`log: ${logFile}\nshow the access token with: agent-terminal token --url`);
        return;
      }
    }
    fail(`did not become healthy in 10s; see ${logFile}`);
  }

  let tls: { cert: string; key: string } | null = null;
  if (config.tls === "auto") {
    if (!isLoopback(config.host)) tls = ensureSelfSigned(loaded.configDir, config.host);
  } else if (typeof config.tls === "object") {
    tls = config.tls;
  }
  if (!tls && !isLoopback(config.host)) {
    console.warn("WARNING: serving plain HTTP on a non-loopback address; the access token and your shell travel unencrypted. Use --tls auto or a TLS proxy.");
  }

  let running;
  try {
    running = await startServer({ config, stateDir: loaded.stateDir, tls, groupPollMs: Number(process.env.AGENT_TERMINAL_GROUP_POLL_MS) || undefined });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") fail(`${config.host}:${config.port} is already in use. Use --port <n>, or \`agent-terminal doctor\`.`);
    throw e;
  }

  console.log(`agent-terminal ${readVersion()} listening on ${running.scheme}://${config.host}:${running.port} (tmux socket "${config.tmuxSocket}", agents: ${config.agents.map((a) => a.id).join(", ")})`);
  const showToken = (loaded.firstRun && process.stdout.isTTY) || v["show-token"] === true;
  if (showToken) {
    const urls = pairingUrls(config);
    console.log("\nOpen this on the device you want to use (it contains your access token):");
    for (const u of urls) console.log(`  ${u}`);
    console.log(await qrText(urls[0]));
    if (loaded.firstRun) console.log("This is shown once. Show it again any time with: agent-terminal token --url   (or --qr)");
  } else {
    console.log("Access token not printed. Show it with: agent-terminal token --url");
  }
  for (const l of exposureHelp(loaded)) console.log(l);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    running.close().finally(() => setTimeout(() => process.exit(0), 200));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (e) {
    fail(`${(e as Error).message}\n\n${HELP}`, 2);
  }
  const { values: v, positionals } = parsed;
  if (v.help) { console.log(HELP); return; }
  if (v.version) { console.log(readVersion()); return; }
  const cmd = positionals[0] ?? "start";
  const flags: Flags = {};
  for (const k of ["host", "port", "tls", "tmux-socket", "config-dir"] as const) if (typeof v[k] === "string") flags[k] = v[k] as string;

  try {
    switch (cmd) {
      case "start":
        return await cmdStart(flags, v);
      case "doctor": {
        const report = await runDoctor({ flags });
        console.log(v.json ? JSON.stringify(report, null, 2) : formatReport(report));
        process.exit(report.ok ? 0 : 1);
        return;
      }
      case "token": {
        const loaded = loadConfig({ flags });
        if (v.qr) {
          const u = pairingUrls(loaded.config)[0];
          console.log(u);
          console.log(await qrText(u));
        } else if (v.url) {
          for (const u of pairingUrls(loaded.config)) console.log(u);
        } else if (v.json) {
          console.log(JSON.stringify({ token: loaded.config.token, urls: pairingUrls(loaded.config) }));
        } else {
          console.log(loaded.config.token);
        }
        return;
      }
      case "install-service": {
        const loaded = loadConfig({ flags, create: false });
        const extra: string[] = [];
        for (const k of ["host", "port", "tls", "tmux-socket", "config-dir"] as const) if (flags[k] !== undefined) extra.push(`--${k}`, flags[k]!);
        const res = installService(
          { node: process.execPath, script: SCRIPT, args: extra, path: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", logFile: path.join(loaded.stateDir, "agent-terminal.log") },
          { dryRun: v["dry-run"] === true, force: v.force === true },
        );
        console.log(res.wrote ? `Wrote ${res.file}` : `--- ${res.file} (dry run, nothing written) ---\n${res.content}`);
        console.log("Not enabled yet. To enable and start it, run:");
        for (const c of res.commands) console.log(`  ${c}`);
        console.log("Then check: agent-terminal status   and   agent-terminal token --url");
        return;
      }
      case "smoke": {
        const res = await runSmoke(flags, positionals[1] || "shell");
        if (v.json) console.log(JSON.stringify(res, null, 2));
        else {
          for (const st of res.steps) console.log(`[${st.ok ? "ok  " : "FAIL"}] ${st.step}${st.detail ? ` (${st.detail})` : ""}`);
          console.log(res.ok ? "smoke ok" : "smoke FAILED");
        }
        process.exit(res.ok ? 0 : 1);
        return;
      }
      case "stop": {
        const loaded = loadConfig({ flags, create: false });
        const file = path.join(loaded.stateDir, "agent-terminal.pid");
        const p = pid(file);
        if (!p || !alive(p)) { try { fs.unlinkSync(file); } catch { /* none */ } console.log("not running (no live background instance found)"); return; }
        process.kill(p, "SIGTERM");
        for (let i = 0; i < 40 && alive(p); i++) await new Promise((r) => setTimeout(r, 150));
        if (alive(p)) fail(`pid ${p} did not exit after SIGTERM`);
        try { fs.unlinkSync(file); } catch { /* gone */ }
        console.log(`stopped (pid ${p}). Agent sessions are still running in tmux; they are re-attached on the next start.`);
        return;
      }
      case "status": {
        const loaded = loadConfig({ flags, create: false });
        const report = await runDoctor({ flags });
        const port = report.checks.find((c) => c.id === "port");
        const running = !!port && /served by agent-terminal/.test(port.message);
        if (v.json) console.log(JSON.stringify({ running, url: baseUrls(loaded.config)[0] }));
        else console.log(running ? `running at ${baseUrls(loaded.config)[0]}` : "not running");
        process.exit(running ? 0 : 3);
        return;
      }
      default:
        fail(`unknown command "${cmd}"\n\n${HELP}`, 2);
    }
  } catch (e) {
    if (e instanceof ConfigError) fail(e.message);
    fail((e as Error).message);
  }
}

main();
