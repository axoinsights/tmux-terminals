/** HTTP(S) + WebSocket server: static UI, /healthz, /api/*, and the `/ws` terminal protocol. */
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Authenticator, COOKIE_NAME } from "./auth.js";
import type { Config } from "./config.js";
import { PtyManager } from "./pty-manager.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { readVersion } from "./version.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(PKG_ROOT, "web");
const require_ = createRequire(import.meta.url);

/** Directory of an installed npm package, found by walking node_modules upward (works hoisted or nested). */
function packageDir(name: string): string | null {
  let dir = PKG_ROOT;
  for (;;) {
    const p = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(p, "package.json"))) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  try { return path.dirname(require_.resolve(`${name}/package.json`)); } catch { return null; }
}

/** Public URL path -> file, served straight from node_modules/@xterm/* (no vendored copies in git). */
export function vendorFiles(): Record<string, string> {
  const map: Record<string, [string, string]> = {
    "xterm.js": ["@xterm/xterm", "lib/xterm.js"],
    "xterm.css": ["@xterm/xterm", "css/xterm.css"],
    "addon-fit.js": ["@xterm/addon-fit", "lib/addon-fit.js"],
    "addon-web-links.js": ["@xterm/addon-web-links", "lib/addon-web-links.js"],
    "addon-search.js": ["@xterm/addon-search", "lib/addon-search.js"],
    "addon-clipboard.js": ["@xterm/addon-clipboard", "lib/addon-clipboard.js"],
    "addon-webgl.js": ["@xterm/addon-webgl", "lib/addon-webgl.js"],
  };
  const out: Record<string, string> = {};
  for (const [name, [pkg, rel]] of Object.entries(map)) {
    const dir = packageDir(pkg);
    if (dir && fs.existsSync(path.join(dir, rel))) out[name] = path.join(dir, rel);
  }
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
};

const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:", "media-src 'self' blob:", "worker-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join("; ");

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Terminal</title><style>body{font:16px system-ui,sans-serif;background:#12121a;color:#d8d8e2;display:grid;place-items:center;min-height:100vh;margin:0}
form{display:flex;flex-direction:column;gap:12px;width:min(92vw,360px)}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #2c2c3a;background:#1a1a26;color:inherit}
button{background:#3d63dd;border-color:#3d63dd;color:#fff}p{color:#7a7a8c;font-size:14px;margin:0}</style></head><body>
<form method="get" action="/"><h1 style="margin:0;font-size:20px">Agent Terminal</h1><p>Enter your access token. Run <code>agent-terminal token</code> on the host to see it.</p>
<input name="token" type="password" autocomplete="current-password" autofocus required placeholder="Access token"><button type="submit">Open</button></form></body></html>`;

export interface RunningServer {
  server: http.Server | https.Server;
  pty: PtyManager;
  scheme: "http" | "https";
  port: number;
  close(): Promise<void>;
}

export interface ServerOptions {
  config: Config;
  stateDir: string;
  tls?: { cert: string; key: string } | null;
  groupPollMs?: number;
}

// Terminal auto-replies (device attributes, cursor position, colour queries, focus events) come back as pty_input from
// EVERY attached xterm, including a background tab; they must not make that tab the size authority.
const TERMINAL_REPLY_RE = /^\x1b(?:\[[?>]?[\d;]*[cRnIO]|\][\d;]+;[^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)$/;

function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  return !!(req.socket as unknown as { encrypted?: boolean }).encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error("payload too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { config } = opts;
  const version = readVersion();
  const auth = new Authenticator(config.token);
  const pty = new PtyManager({ tmuxSocket: config.tmuxSocket, agents: config.agents, groups: config.groups, stateDir: opts.stateDir, groupPollMs: opts.groupPollMs });
  const vendor = vendorFiles();
  const indexHtml = fs.readFileSync(path.join(WEB_DIR, "index.html"));
  const manifest = JSON.stringify({
    name: "Agent Terminal", short_name: "Terminal", start_url: "/", scope: "/", display: "standalone",
    background_color: "#12121a", theme_color: "#12121a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  });

  const clients = new Set<WebSocket>();
  const attachments = new Map<WebSocket, Set<string>>();
  const sizes = new Map<string, Map<WebSocket, { cols: number; rows: number; at: number }>>();
  const lastInput = new Map<string, WebSocket>();

  const sendMsg = (ws: WebSocket, msg: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcastList = () => { const m: ServerMessage = { type: "pty_list", sessions: pty.list() }; for (const c of clients) sendMsg(c, m); };

  function applySize(id: string): void {
    const m = sizes.get(id);
    if (!m || m.size === 0) return;
    const input = lastInput.get(id);
    let want = input ? m.get(input) : undefined;
    if (!want) for (const sz of m.values()) if (!want || sz.at > want.at) want = sz;
    if (want) pty.resize(id, want.cols, want.rows);
  }
  function dropClient(ws: WebSocket, id?: string): void {
    for (const sid of id ? [id] : [...sizes.keys()]) {
      sizes.get(sid)?.delete(ws);
      if (lastInput.get(sid) === ws) lastInput.delete(sid);
      if (sizes.get(sid)?.size === 0) sizes.delete(sid);
      else applySize(sid);
    }
  }
  pty.onData((id, data) => { for (const [ws, ids] of attachments) if (ids.has(id)) sendMsg(ws, { type: "pty_output", sessionId: id, data }); });
  pty.onExit((id, code) => {
    sizes.delete(id);
    lastInput.delete(id);
    for (const [ws, ids] of attachments) if (ids.has(id)) sendMsg(ws, { type: "pty_exit", sessionId: id, code });
    broadcastList();
  });

  function handleMessage(ws: WebSocket, msg: ClientMessage): void {
    const attach = (id: string) => { let s = attachments.get(ws); if (!s) attachments.set(ws, (s = new Set())); s.add(id); };
    switch (msg.type) {
      case "pty_order":
        if (!pty.setOrder(msg.order)) sendMsg(ws, { type: "pty_error", message: "Reorder failed (bad order list)" });
        broadcastList();
        return;
      case "pty_spawn":
        try {
          const session = pty.spawn(msg.agent, msg.cwd, msg.cols || 100, msg.rows || 30, msg.resume === true);
          attach(session.id);
          sendMsg(ws, { type: "pty_spawned", session });
          broadcastList();
        } catch (e) { sendMsg(ws, { type: "pty_error", message: (e as Error).message }); }
        return;
      case "pty_input":
        if (typeof msg.data !== "string" || msg.data.length > 1_000_000) return;
        pty.write(msg.sessionId, msg.data);
        if (lastInput.get(msg.sessionId) !== ws && !TERMINAL_REPLY_RE.test(msg.data)) { lastInput.set(msg.sessionId, ws); applySize(msg.sessionId); }
        return;
      case "pty_resize": {
        if (!Number.isFinite(msg.cols) || !Number.isFinite(msg.rows) || !pty.get(msg.sessionId)) return;
        let m = sizes.get(msg.sessionId);
        if (!m) sizes.set(msg.sessionId, (m = new Map()));
        m.set(ws, { cols: msg.cols, rows: msg.rows, at: Date.now() });
        applySize(msg.sessionId);
        return;
      }
      case "pty_kill":
        attachments.get(ws)?.delete(msg.sessionId);
        dropClient(ws, msg.sessionId);
        pty.kill(msg.sessionId);
        return;
      case "pty_attach": {
        if (!pty.get(msg.sessionId)) { sendMsg(ws, { type: "pty_error", message: "Session not found", sessionId: msg.sessionId }); return; }
        attach(msg.sessionId);
        const tail = pty.getScrollbackTail(msg.sessionId);
        sendMsg(ws, { type: "pty_scrollback", sessionId: msg.sessionId, data: tail.data, truncated: tail.truncated });
        return;
      }
      case "pty_detach":
        attachments.get(ws)?.delete(msg.sessionId);
        dropClient(ws, msg.sessionId);
        return;
      case "pty_rename":
        if (!pty.rename(msg.sessionId, msg.title)) { sendMsg(ws, { type: "pty_error", message: "Rename failed (unknown session or name over 80 chars)", sessionId: msg.sessionId }); return; }
        broadcastList();
        return;
      case "pty_list":
        sendMsg(ws, { type: "pty_list", sessions: pty.list() });
        return;
    }
  }

  function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, {
      "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "Content-Security-Policy": CSP, ...extra,
    });
    res.end(body);
  }
  const json = (res: http.ServerResponse, status: number, obj: unknown, extra: Record<string, string> = {}) => send(res, status, JSON.stringify(obj), "application/json", extra);

  function serveFile(res: http.ServerResponse, file: string): void {
    try {
      send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream", { "Cache-Control": "public, max-age=3600" });
    } catch { json(res, 404, { error: "not found" }); }
  }

  async function handleTranscribe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!config.transcribeUrl) { json(res, 404, { error: "transcription is not configured" }); return; }
    const body = await readBody(req, 25 * 1024 * 1024);
    if (body.length === 0) { json(res, 400, { error: "empty body" }); return; }
    const type = String(req.headers["content-type"] || "audio/webm").split(";")[0];
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(body)], { type }), `audio.${type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"}`);
    form.append("model", config.transcribeModel);
    const headers: Record<string, string> = {};
    if (config.transcribeApiKey) headers.Authorization = `Bearer ${config.transcribeApiKey}`;
    const r = await fetch(config.transcribeUrl, { method: "POST", body: form, headers, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) { json(res, 502, { error: `transcription backend returned HTTP ${r.status}` }); return; }
    const data = (await r.json()) as { text?: string };
    json(res, 200, { text: typeof data.text === "string" ? data.text : "" });
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url || "/", "http://x");
    const p = url.pathname;
    const method = req.method || "GET";
    if (p === "/healthz" && (method === "GET" || method === "HEAD")) { json(res, 200, { ok: true, version }); return; }
    // Public, secret-free PWA assets: browsers fetch the manifest and its icons without credentials.
    if (p === "/manifest.webmanifest") { send(res, 200, manifest, "application/manifest+json", { "Cache-Control": "public, max-age=3600" }); return; }
    const icon = /^\/icons\/(icon-192|icon-512)\.png$/.exec(p);
    if (icon) { serveFile(res, path.join(WEB_DIR, "icons", `${icon[1]}.png`)); return; }

    const result = auth.check(req, clientIp(req));
    if (!result.ok) {
      if (result.status === 429) { json(res, 429, { error: "too many bad tokens, slow down" }, { "Retry-After": String(result.retryAfter ?? 1) }); return; }
      if (method === "GET" && (p === "/" || p === "/index.html") && !req.headers.authorization) { send(res, 401, LOGIN_PAGE, "text/html; charset=utf-8"); return; }
      json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="agent-terminal"' });
      return;
    }

    // Token in the URL: turn it into an HttpOnly cookie and redirect to a clean URL (the token leaves history and Referer).
    if (result.via === "query" && method === "GET" && (p === "/" || p === "/index.html" || p === "/terminal")) {
      const secure = isSecureRequest(req) ? "; Secure" : "";
      url.searchParams.delete("token");
      const rest = url.searchParams.toString();
      res.writeHead(302, {
        Location: "/" + (rest ? `?${rest}` : ""), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
      });
      res.end();
      return;
    }

    if (method === "GET" || method === "HEAD") {
      if (p === "/" || p === "/index.html" || p === "/terminal") { send(res, 200, indexHtml, "text/html; charset=utf-8"); return; }
      const v = /^\/vendor\/([\w.-]+)$/.exec(p);
      if (v) { if (vendor[v[1]]) serveFile(res, vendor[v[1]]); else json(res, 404, { error: "not found" }); return; }
      if (p === "/api/config") {
        json(res, 200, {
          version,
          agents: config.agents.map((a) => ({ id: a.id, label: a.label, canResume: a.resumeArgs.length > 0, available: pty.resolveAgentCommand(a) !== null })),
          groups: config.groups.map((g) => g.label),
          cwdPresets: config.cwdPresets,
          transcribe: !!config.transcribeUrl,
        });
        return;
      }
      if (p === "/api/sessions") { json(res, 200, { sessions: pty.list() }); return; }
    }
    if (method === "POST" && p === "/api/transcribe") {
      const origin = req.headers.origin;
      if (origin && safeHost(origin) !== req.headers.host) { json(res, 403, { error: "cross-origin request refused" }); return; }
      try { await handleTranscribe(req, res); } catch (e) {
        const status = (e as { status?: number }).status || 502;
        if (!res.headersSent) json(res, status, { error: status === 413 ? "audio too large" : "transcription failed" });
      }
      return;
    }
    json(res, 404, { error: "not found" });
  };

  const requestListener = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handler(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: "internal error" }); else res.end(); });
  };
  const server: http.Server | https.Server = opts.tls
    ? https.createServer({ cert: fs.readFileSync(opts.tls.cert), key: fs.readFileSync(opts.tls.key) }, requestListener)
    : http.createServer(requestListener);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const reject = (status: number, text: string) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname !== "/ws") return reject(404, "Not Found");
    const result = auth.check(req, clientIp(req));
    if (!result.ok) return reject(result.status, result.status === 429 ? "Too Many Requests" : "Unauthorized");
    const origin = req.headers.origin;
    if (origin && safeHost(origin) !== req.headers.host) return reject(403, "Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      (ws as WebSocket & { alive?: boolean }).alive = true;
      ws.on("pong", () => { (ws as WebSocket & { alive?: boolean }).alive = true; });
      ws.on("message", (raw) => {
        let msg: ClientMessage;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg.type !== "string") return;
        try { handleMessage(ws, msg); } catch (e) { sendMsg(ws, { type: "pty_error", message: (e as Error).message }); }
      });
      ws.on("close", () => { clients.delete(ws); attachments.delete(ws); dropClient(ws); });
      ws.on("error", () => ws.close());
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      const w = ws as WebSocket & { alive?: boolean };
      if (w.alive === false) { ws.terminate(); continue; }
      w.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, 30_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
  });

  const adopted = pty.adoptExisting();
  pty.watchGroups(broadcastList);
  if (adopted > 0) console.log(`[agent-terminal] adopted ${adopted} running session(s) from the previous run`);

  const addr = server.address();
  return {
    server, pty, scheme: opts.tls ? "https" : "http", port: typeof addr === "object" && addr ? addr.port : config.port,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      pty.detachAll();
      for (const ws of clients) ws.terminate();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function safeHost(origin: string): string | null {
  try { return new URL(origin).host; } catch { return null; }
}
