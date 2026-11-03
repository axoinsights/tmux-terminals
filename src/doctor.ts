/** `tmux-terminals doctor`: environment checks with concrete fixes. Exit code non-zero when any check fails. */
import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import { spawnSync } from "node:child_process";
import { ConfigError, isLoopback, loadConfig, which, type Flags } from "./config.js";
import { hasOpenssl, certIsFresh } from "./tls.js";
import { effectiveScheme } from "./pairing.js";
import { readVersion } from "./version.js";

export interface Check {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}
export interface Report {
  ok: boolean;
  version: string;
  node: string;
  platform: string;
  checks: Check[];
}

const installTmux = "Install tmux: apt-get install -y tmux | dnf install -y tmux | brew install tmux";

async function probeHealth(host: string, port: number, scheme: "http" | "https"): Promise<{ ok: boolean; version?: string }> {
  return new Promise((resolve) => {
    const lib = scheme === "https" ? https : http;
    const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const req = lib.get({ host: target, port, path: "/healthz", timeout: 2000, rejectUnauthorized: false } as https.RequestOptions, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve({ ok: j.ok === true, version: j.version });
        } catch { resolve({ ok: false }); }
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
  });
}

function portFree(host: string, port: number): Promise<{ free: boolean; code?: string }> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve({ free: false, code: e.code }));
    s.listen(port, host, () => s.close(() => resolve({ free: true })));
  });
}

async function ptyCheck(): Promise<Check> {
  const fix =
    "The native module failed to load. Prebuilt binaries cover Linux/macOS x64+arm64; otherwise build from source: " +
    "install build tools (Debian/Ubuntu: apt-get install -y build-essential python3; Fedora: dnf install -y gcc-c++ make python3; macOS: xcode-select --install) " +
    "then run: npm rebuild @homebridge/node-pty-prebuilt-multiarch --build-from-source";
  try {
    const pty = await import("@homebridge/node-pty-prebuilt-multiarch");
    const out = await new Promise<string>((resolve, reject) => {
      const p = pty.spawn("/bin/sh", ["-c", "echo tmux-terminals-pty-ok"], { name: "xterm-256color", cols: 80, rows: 24 });
      let buf = "";
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } reject(new Error("pty produced no output within 4s")); }, 4000);
      p.onData((d) => { buf += d; if (buf.includes("tmux-terminals-pty-ok")) { clearTimeout(t); resolve(buf); } });
    });
    return { id: "node-pty", status: out ? "ok" : "fail", message: "node-pty loads and can run a command" };
  } catch (e) {
    return { id: "node-pty", status: "fail", message: `node-pty failed: ${(e as Error).message.split("\n")[0]}`, fix };
  }
}

export interface DoctorOptions {
  flags?: Flags;
  env?: NodeJS.ProcessEnv;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<Report> {
  const env = opts.env ?? process.env;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20
    ? { id: "node", status: "ok", message: `Node ${process.versions.node}` }
    : { id: "node", status: "fail", message: `Node ${process.versions.node} is too old (need >= 20)`, fix: "Install Node 20 or newer (https://nodejs.org or nvm install 22)" });

  if (process.platform === "win32") {
    add({ id: "platform", status: "fail", message: "Windows is not supported natively", fix: "Use WSL2 (Ubuntu) and run tmux-terminals inside it" });
  } else {
    add({ id: "platform", status: "ok", message: process.platform });
  }

  const tmuxBin = which("tmux", env.PATH);
  if (!tmuxBin) {
    add({ id: "tmux", status: "fail", message: "tmux not found on PATH", fix: installTmux });
  } else {
    const v = spawnSync(tmuxBin, ["-V"], { encoding: "utf8" }).stdout.trim();
    const m = /(\d+)\.(\d+)/.exec(v);
    const tooOld = m ? Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 2) : false;
    add(tooOld
      ? { id: "tmux", status: "warn", message: `${v} is old; clipboard passthrough and extended keys need tmux 3.3+`, fix: "Upgrade tmux to 3.3 or newer" }
      : { id: "tmux", status: "ok", message: `${v} at ${tmuxBin}` });
  }

  add(await ptyCheck());

  let loaded;
  try {
    loaded = loadConfig({ flags: opts.flags, env, create: false });
    add({ id: "config", status: "ok", message: fs.existsSync(loaded.configFile) ? `config ok (${loaded.configFile})` : `no config file yet; ${loaded.configFile} is created on first run` });
  } catch (e) {
    add({ id: "config", status: "fail", message: e instanceof ConfigError ? e.message : `config error: ${(e as Error).message}`, fix: "Fix or delete the offending setting in config.json (or the TMUX_TERMINALS_* variable)" });
    return finish(checks);
  }
  const { config, configFile } = loaded;

  try {
    const mode = fs.statSync(configFile).mode & 0o777;
    if (mode & 0o077) add({ id: "config-perms", status: "warn", message: `${configFile} is mode ${mode.toString(8)}; it holds the access token`, fix: `chmod 600 ${configFile}` });
  } catch { /* no file */ }

  add({ id: "tmux-socket", status: "ok", message: `dedicated tmux socket "${config.tmuxSocket}" (your default tmux server is never touched)` });

  const scheme = effectiveScheme(config);
  const free = await portFree(config.host, config.port);
  if (free.free) {
    add({ id: "port", status: "ok", message: `${config.host}:${config.port} is free` });
  } else if (free.code === "EADDRINUSE") {
    const h = await probeHealth(config.host, config.port, scheme);
    add(h.ok
      ? { id: "port", status: "ok", message: `${config.host}:${config.port} is served by tmux-terminals ${h.version ?? ""} (already running)`.trim() }
      : { id: "port", status: "fail", message: `${config.host}:${config.port} is in use by another program`, fix: `Pick another port: tmux-terminals --port 8800 (or set "port" in ${configFile})` });
  } else {
    add({ id: "port", status: "fail", message: `cannot bind ${config.host}:${config.port} (${free.code})`, fix: "Check the host address and port permissions (ports < 1024 need root)" });
  }

  if (config.tls === "auto" && !isLoopback(config.host)) {
    if (!hasOpenssl()) {
      add({ id: "tls", status: "fail", message: "tls is auto and host is not loopback, but openssl is missing", fix: 'Install openssl, or set "tls" to "off" (only behind a TLS-terminating proxy) or to { cert, key } paths' });
    } else {
      const cert = `${loaded.configDir}/cert.pem`;
      add({ id: "tls", status: "ok", message: fs.existsSync(cert) && certIsFresh(cert, config.host) ? "self-signed certificate present" : "a self-signed certificate will be generated on start" });
    }
  } else if (typeof config.tls === "object") {
    const missing = [config.tls.cert, config.tls.key].filter((f) => !fs.existsSync(f));
    add(missing.length
      ? { id: "tls", status: "fail", message: `TLS file(s) not found: ${missing.join(", ")}`, fix: "Fix the cert/key paths in config.json" }
      : { id: "tls", status: "ok", message: "custom TLS certificate configured" });
  } else if (config.tls === "off" && !isLoopback(config.host)) {
    add({ id: "tls", status: "warn", message: "plain HTTP on a non-loopback address: the token travels unencrypted", fix: 'Use "tls": "auto", or bind to 127.0.0.1 behind a TLS proxy (tailscale serve)' });
  } else {
    add({ id: "tls", status: "ok", message: isLoopback(config.host) ? "loopback only; TLS not needed" : "tls configured" });
  }

  const found = config.agents.filter((a) => which(a.command.startsWith("~/") ? a.command.replace("~", process.env.HOME || "~") : a.command, env.PATH));
  for (const a of config.agents) {
    const ok = found.includes(a);
    if (!ok) add({ id: `agent:${a.id}`, status: "warn", message: `agent "${a.id}": command "${a.command}" not found on PATH`, fix: `Install it, or remove it from "agents" in ${configFile}` });
  }
  add(found.length
    ? { id: "agents", status: "ok", message: `usable agents: ${found.map((a) => a.id).join(", ")}` }
    : { id: "agents", status: "fail", message: "none of the configured agents can be started", fix: 'Configure at least one agent whose command exists, e.g. { "id": "shell", "command": "bash" }' });

  return finish(checks);
}

function finish(checks: Check[]): Report {
  return { ok: !checks.some((c) => c.status === "fail"), version: readVersion(), node: process.versions.node, platform: `${process.platform}-${process.arch}`, checks };
}

export function formatReport(r: Report): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  const lines = [`tmux-terminals ${r.version} doctor (node ${r.node}, ${r.platform})`, ""];
  for (const c of r.checks) {
    lines.push(`[${mark[c.status]}] ${c.message}`);
    if (c.fix && c.status !== "ok") lines.push(`       fix: ${c.fix}`);
  }
  lines.push("", r.ok ? "All required checks passed." : "Some checks failed; apply the fixes above and re-run `tmux-terminals doctor`.");
  return lines.join("\n");
}
