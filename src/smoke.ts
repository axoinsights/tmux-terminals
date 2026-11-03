/** `tmux-terminals smoke`: end-to-end check of a RUNNING server (healthz, auth required, authenticated WebSocket, shell echo, kill). */
import * as crypto from "node:crypto";
import { WebSocket } from "ws";
import { loadConfig, type Flags } from "./config.js";
import { effectiveScheme } from "./pairing.js";

export interface SmokeResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string }[];
}

export async function runSmoke(flags: Flags, agent = "shell"): Promise<SmokeResult> {
  const { config } = loadConfig({ flags, create: false });
  const scheme = effectiveScheme(config);
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;
  const base = `${scheme}://${host}:${config.port}`;
  const steps: SmokeResult["steps"] = [];
  const rec = (step: string, ok: boolean, detail?: string) => { steps.push({ step, ok, detail }); return ok; };
  // Self-signed certificate on a LAN bind: this process only talks to itself, so skip verification for this check only.
  if (scheme === "https") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  try {
    const h = (await (await fetch(`${base}/healthz`)).json()) as { ok?: boolean; version?: string };
    if (!rec("healthz answers without a token", h.ok === true, `version ${h.version}`)) return { ok: false, steps };
    const un = await fetch(`${base}/api/config`);
    if (!rec("other routes refuse a request without the token", un.status === 401, `HTTP ${un.status}`)) return { ok: false, steps };

    const marker = `AT_SMOKE_${crypto.randomBytes(4).toString("hex")}`;
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, { headers: { Authorization: `Bearer ${config.token}` } });
    const echoed = await new Promise<boolean | string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout waiting for the echoed marker"), 15000);
      let sid: string | null = null, buf = "", sent = false;
      ws.on("error", (e) => { clearTimeout(timer); resolve(`websocket error: ${e.message}`); });
      ws.on("open", () => ws.send(JSON.stringify({ type: "pty_spawn", agent, cwd: "~", cols: 100, rows: 30 })));
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "pty_error") { clearTimeout(timer); resolve(m.message); }
        if (m.type === "pty_spawned") {
          sid = m.session.id;
          setTimeout(() => { sent = true; ws.send(JSON.stringify({ type: "pty_input", sessionId: sid, data: `echo ${marker.slice(0, 8)}''${marker.slice(8)}\r` })); }, 800);
        }
        if (m.type === "pty_output" && sent) {
          buf += m.data;
          if (buf.includes(marker)) { clearTimeout(timer); ws.send(JSON.stringify({ type: "pty_kill", sessionId: sid })); setTimeout(() => resolve(true), 300); }
        }
      });
    });
    ws.close();
    rec(`authenticated WebSocket: spawned "${agent}", typed a command, got its output back, killed the session`, echoed === true, echoed === true ? undefined : String(echoed));
  } catch (e) {
    rec("server reachable", false, `${(e as Error).message}. Is it running? (tmux-terminals status)`);
  }
  return { ok: steps.every((s) => s.ok), steps };
}
