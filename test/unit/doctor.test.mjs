import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runDoctor, formatReport } from "../../dist/doctor.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "at-doc-"));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

test("healthy environment: ok, JSON-serialisable, every check has a status", async () => {
  const port = await freePort();
  const r = await runDoctor({ flags: { port: String(port) }, env: { ...process.env, AGENT_TERMINAL_CONFIG_DIR: tmp() } });
  assert.equal(r.ok, true, formatReport(r));
  assert.ok(r.checks.length >= 8);
  for (const c of r.checks) assert.ok(["ok", "warn", "fail"].includes(c.status));
  assert.ok(r.checks.find((c) => c.id === "node-pty" && c.status === "ok"));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
});

test("missing tmux is a failure with an install hint", async () => {
  const port = await freePort();
  const r = await runDoctor({ flags: { port: String(port) }, env: { AGENT_TERMINAL_CONFIG_DIR: tmp(), PATH: "/nonexistent", SHELL: "/bin/sh" } });
  const c = r.checks.find((x) => x.id === "tmux");
  assert.equal(c.status, "fail");
  assert.match(c.fix, /apt-get install -y tmux/);
  assert.equal(r.ok, false);
});

test("port in use by another program is a failure; our own server would be ok", async () => {
  const blocker = net.createServer();
  await new Promise((res) => blocker.listen(0, "127.0.0.1", res));
  const port = blocker.address().port;
  const r = await runDoctor({ flags: { port: String(port) }, env: { ...process.env, AGENT_TERMINAL_CONFIG_DIR: tmp() } });
  blocker.close();
  const c = r.checks.find((x) => x.id === "port");
  assert.equal(c.status, "fail");
  assert.match(c.fix, /--port/);
});

test("invalid config is reported, not thrown", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
  const r = await runDoctor({ env: { ...process.env, AGENT_TERMINAL_CONFIG_DIR: dir } });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((x) => x.id === "config").status, "fail");
});

test("world-readable config file is flagged (it holds the token)", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "t".repeat(24) }), { mode: 0o644 });
  fs.chmodSync(path.join(dir, "config.json"), 0o644);
  const port = await freePort();
  const r = await runDoctor({ flags: { port: String(port) }, env: { ...process.env, AGENT_TERMINAL_CONFIG_DIR: dir } });
  assert.equal(r.checks.find((x) => x.id === "config-perms").status, "warn");
});
