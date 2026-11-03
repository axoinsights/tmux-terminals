import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startServer } from "../../dist/server.js";
import { loadConfig } from "../../dist/config.js";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const TOKEN = crypto.randomBytes(18).toString("base64url");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-srv-"));
const { config } = loadConfig({
  env: { TMUX_TERMINALS_CONFIG_DIR: dir, TMUX_TERMINALS_TOKEN: TOKEN, TMUX_TERMINALS_TMUX_SOCKET: `at-unit-${process.pid}-${crypto.randomBytes(2).toString("hex")}` },
});
const srv = await startServer({ config: { ...config, port: 0 }, stateDir: dir });
const base = `http://127.0.0.1:${srv.port}`;
test.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const get = (p, headers = {}) => fetch(base + p, { headers, redirect: "manual" });

test("/healthz is public and reveals only ok + version", async () => {
  const r = await get("/healthz");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ["ok", "version"]);
  assert.equal(j.ok, true);
});

test("every other route needs the token, even from localhost", async () => {
  for (const p of ["/", "/terminal", "/api/config", "/api/sessions", "/vendor/xterm.js"]) {
    const r = await get(p);
    assert.equal(r.status, 401, p);
  }
  assert.equal((await fetch(base + "/api/transcribe", { method: "POST", body: "x" })).status, 401);
  assert.equal((await get("/api/config", { Authorization: "Bearer wrong-wrong-wrong" })).status, 401);
  assert.equal((await get("/api/config", { Authorization: `Bearer ${TOKEN}` })).status, 200);
});

test("the unauthenticated page is a token form that leaks nothing", async () => {
  const r = await get("/");
  const html = await r.text();
  assert.match(html, /name="token"/);
  assert.ok(!html.includes(TOKEN));
});

test("opening ?token= sets an HttpOnly cookie and redirects to a URL without the token", async () => {
  const r = await get(`/?token=${TOKEN}&ui=en`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/?ui=en");
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /^tmux_terminals_auth=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.ok(!/Secure/.test(cookie), "no Secure flag on plain http");
  const page = await get("/", { Cookie: cookie.split(";")[0] });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Tmux Terminals/);
  const proxied = await get(`/?token=${TOKEN}`, { "X-Forwarded-Proto": "https" });
  assert.match(proxied.headers.get("set-cookie"), /Secure/);
});

test("responses carry security headers; vendor files come from node_modules", async () => {
  const r = await get("/vendor/xterm.js", { Authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await get("/vendor/..%2Fpackage.json", { Authorization: `Bearer ${TOKEN}` })).status, 404);
});

test("PWA manifest and icons are public and secret-free", async () => {
  const m = await get("/manifest.webmanifest");
  assert.equal(m.status, 200);
  const text = await m.text();
  assert.ok(!text.includes(TOKEN));
  assert.equal(JSON.parse(text).start_url, "/");
  assert.equal((await get("/icons/icon-192.png")).status, 200);
});

test("/api/config exposes agents and hides the dictation button without transcribeUrl", async () => {
  const j = await (await get("/api/config", { Authorization: `Bearer ${TOKEN}` })).json();
  assert.ok(j.agents.some((a) => a.id === "shell"));
  assert.equal(j.transcribe, false);
  assert.equal((await fetch(base + "/api/transcribe", { method: "POST", body: "x", headers: { Authorization: `Bearer ${TOKEN}` } })).status, 404);
});

const wsOpen = (headers) => new Promise((resolve) => {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers });
  ws.on("open", () => resolve({ ok: true, ws }));
  ws.on("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode }));
  ws.on("error", () => resolve({ ok: false, status: 0 }));
});

test("WebSocket: token required (also from localhost) and Origin must match Host", async () => {
  assert.deepEqual(await wsOpen({}), { ok: false, status: 401 });
  assert.deepEqual(await wsOpen({ Authorization: "Bearer nope-nope-nope" }), { ok: false, status: 401 });
  const evil = await wsOpen({ Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" });
  assert.deepEqual(evil, { ok: false, status: 403 });
  const same = await wsOpen({ Authorization: `Bearer ${TOKEN}`, Origin: base });
  assert.equal(same.ok, true);
  same.ws.close();
  const noOrigin = await wsOpen({ Authorization: `Bearer ${TOKEN}` });
  assert.equal(noOrigin.ok, true);
  noOrigin.ws.close();
});

test("spawn validation: unknown agent and missing directory are refused with a clear error", async () => {
  const { ws } = await wsOpen({ Authorization: `Bearer ${TOKEN}` });
  const next = () => new Promise((resolve) => ws.once("message", (m) => resolve(JSON.parse(m.toString()))));
  ws.send(JSON.stringify({ type: "pty_spawn", agent: "nope", cwd: "~" }));
  assert.match((await next()).message, /Unknown agent/);
  ws.send(JSON.stringify({ type: "pty_spawn", agent: "shell", cwd: "/definitely/not/here" }));
  assert.match((await next()).message, /does not exist/);
  ws.send(JSON.stringify({ type: "pty_spawn", agent: "shell", cwd: "relative/dir" }));
  assert.match((await next()).message, /absolute/);
  ws.close();
});

test("repeated bad tokens get rate limited (429) without affecting the real token", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await get("/api/config", { Authorization: "Bearer guess-guess-guess-" + i })).status;
  assert.equal(last, 429);
  assert.equal((await get("/api/config", { Authorization: `Bearer ${TOKEN}` })).status, 200);
});

void http;
