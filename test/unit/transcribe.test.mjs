import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../dist/server.js";
import { loadConfig } from "../../dist/config.js";

test("dictation: audio is forwarded to the OpenAI-compatible endpoint and the text returned; mic shown in /api/config", async () => {
  let seen = null;
  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = { url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks).toString("latin1") };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: "hello from whisper" }));
    });
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const token = crypto.randomBytes(18).toString("base64url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-tr-"));
  const { config } = loadConfig({
    env: {
      AGENT_TERMINAL_CONFIG_DIR: dir, AGENT_TERMINAL_TOKEN: token, AGENT_TERMINAL_TMUX_SOCKET: `at-unit-tr-${process.pid}`,
      AGENT_TERMINAL_TRANSCRIBE_URL: `http://127.0.0.1:${backend.address().port}/v1/audio/transcriptions`, AGENT_TERMINAL_TRANSCRIBE_API_KEY: "sk-test",
    },
  });
  const srv = await startServer({ config: { ...config, port: 0 }, stateDir: dir });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const cfg = await (await fetch(base + "/api/config", { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(cfg.transcribe, true);
    const r = await fetch(base + "/api/transcribe", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/webm" }, body: Buffer.from("FAKEAUDIO") });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { text: "hello from whisper" });
    assert.equal(seen.url, "/v1/audio/transcriptions");
    assert.equal(seen.auth, "Bearer sk-test");
    assert.match(seen.type, /multipart\/form-data/);
    assert.ok(seen.body.includes("FAKEAUDIO") && seen.body.includes('name="model"') && seen.body.includes("whisper-1"));
    const cross = await fetch(base + "/api/transcribe", { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" }, body: "x" });
    assert.equal(cross.status, 403);
  } finally {
    await srv.close();
    backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
