import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.resolve("bin/tmux-terminals.mjs");
const run = (args, dir, extraEnv = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, TMUX_TERMINALS_CONFIG_DIR: dir, TMUX_TERMINALS_TOKEN: "", ...extraEnv } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "at-cli-"));

test("--help and --version work and exit 0; unknown commands exit 2", () => {
  const d = tmp();
  assert.equal(run(["--help"], d).status, 0);
  assert.match(run(["--help"], d).stdout, /install-service/);
  assert.match(run(["--version"], d).stdout, /^\d+\.\d+\.\d+/);
  assert.equal(run(["bogus"], d).status, 2);
});

test("token prints the generated token; --url builds a pairing URL; token is stable across calls", () => {
  const d = tmp();
  const t1 = run(["token"], d).stdout.trim();
  assert.ok(t1.length >= 32);
  assert.equal(run(["token"], d).stdout.trim(), t1);
  assert.equal(run(["token", "--url", "--port", "9001"], d).stdout.trim(), `http://127.0.0.1:9001/?token=${encodeURIComponent(t1)}`);
  assert.equal(JSON.parse(run(["token", "--json"], d).stdout).token, t1);
});

test("config show hides the token; config set validates and rolls back bad values", () => {
  const d = tmp();
  const token = run(["token"], d).stdout.trim();
  const shown = run(["config", "show"], d).stdout;
  assert.ok(!shown.includes(token));
  assert.equal(run(["config", "set", "port", "9100"], d).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8")).port, 9100);
  assert.notEqual(run(["config", "set", "port", "abc"], d).status, 0);
  assert.notEqual(run(["config", "set", "tmuxSocket", "default"], d).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "config.json"), "utf8")).tmuxSocket, "tmux-terminals");
  assert.notEqual(run(["config", "set", "token", "x"], d).status, 0, "the token cannot be set through argv");
});

test("doctor --json prints valid JSON and the exit code follows ok", () => {
  const d = tmp();
  const r = run(["doctor", "--json", "--port", "1"], d); // port 1: not bindable by a normal user -> a failing check
  const j = JSON.parse(r.stdout);
  assert.equal(typeof j.ok, "boolean");
  assert.equal(r.status, j.ok ? 0 : 1);
  const bad = run(["doctor", "--json"], d, { PATH: "/nonexistent" });
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.equal(bad.status, 1);
});

test("status exits 3 when nothing is listening", () => {
  const d = tmp();
  const r = run(["status", "--port", "1"], d);
  assert.equal(r.status, 3);
});
