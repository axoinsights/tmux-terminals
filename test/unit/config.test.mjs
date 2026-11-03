import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, ConfigError, defaultAgents, validateAgents, isLoopback } from "../../dist/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "at-cfg-"));
const noAgents = () => null; // pretend nothing but the shell is installed

test("first run creates a 0600 config file with a generated token and safe defaults", () => {
  const dir = tmp();
  const r = loadConfig({ env: { TMUX_TERMINALS_CONFIG_DIR: dir, SHELL: "/bin/sh", PATH: "" }, find: (c) => (c === "/bin/sh" ? c : null) });
  assert.equal(r.firstRun, true);
  assert.equal(r.config.host, "127.0.0.1");
  assert.equal(r.config.tmuxSocket, "tmux-terminals");
  assert.equal(r.config.tls, "auto");
  assert.ok(r.config.token.length >= 32);
  const file = path.join(dir, "config.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const again = loadConfig({ env: { TMUX_TERMINALS_CONFIG_DIR: dir }, find: noAgents });
  assert.equal(again.firstRun, false);
  assert.equal(again.config.token, r.config.token);
  assert.equal(again.tokenSource, "file");
});

test("precedence: flags > env > file > defaults", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 1111, host: "0.0.0.0", token: "f".repeat(24), tmuxSocket: "from-file" }));
  const env = { TMUX_TERMINALS_CONFIG_DIR: dir };
  assert.equal(loadConfig({ env, find: noAgents }).config.port, 1111);
  assert.equal(loadConfig({ env: { ...env, TMUX_TERMINALS_PORT: "2222" }, find: noAgents }).config.port, 2222);
  assert.equal(loadConfig({ env: { ...env, TMUX_TERMINALS_PORT: "2222" }, flags: { port: "3333" }, find: noAgents }).config.port, 3333);
  assert.equal(loadConfig({ env, find: noAgents }).config.tmuxSocket, "from-file");
  assert.equal(loadConfig({ env: { ...env, TMUX_TERMINALS_TMUX_SOCKET: "from-env" }, find: noAgents }).config.tmuxSocket, "from-env");
});

test("token from env wins over the file and is never written to disk", () => {
  const dir = tmp();
  const r = loadConfig({ env: { TMUX_TERMINALS_CONFIG_DIR: dir, TMUX_TERMINALS_TOKEN: "e".repeat(20) }, find: noAgents });
  assert.equal(r.config.token, "e".repeat(20));
  assert.equal(r.tokenSource, "env");
  assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
});

test("rejects short tokens, bad ports and the default tmux socket", () => {
  const dir = tmp();
  const env = { TMUX_TERMINALS_CONFIG_DIR: dir };
  assert.throws(() => loadConfig({ env: { ...env, TMUX_TERMINALS_TOKEN: "short" }, find: noAgents }), ConfigError);
  assert.throws(() => loadConfig({ env: { ...env, TMUX_TERMINALS_PORT: "99999" }, find: noAgents }), /port/);
  assert.throws(() => loadConfig({ env, flags: { "tmux-socket": "default" }, find: noAgents }), /default/);
  assert.throws(() => loadConfig({ env, flags: { "tmux-socket": "../evil" }, find: noAgents }), /socket/);
});

test("groups: validated, cannot reuse the main socket or the default one", () => {
  const dir = tmp();
  const env = { TMUX_TERMINALS_CONFIG_DIR: dir };
  const ok = loadConfig({ env: { ...env, TMUX_TERMINALS_GROUPS: JSON.stringify([{ label: "Cloud", socket: "work" }]) }, find: noAgents });
  assert.deepEqual(ok.config.groups, [{ label: "Cloud", socket: "work" }]);
  assert.throws(() => loadConfig({ env: { ...env, TMUX_TERMINALS_GROUPS: JSON.stringify([{ label: "x", socket: "tmux-terminals" }]) }, find: noAgents }), /equals tmuxSocket/);
  assert.throws(() => loadConfig({ env: { ...env, TMUX_TERMINALS_GROUPS: JSON.stringify([{ label: "x", socket: "default" }]) }, find: noAgents }), /default/);
});

test("tls setting: auto | off | cert,key", () => {
  const env = { TMUX_TERMINALS_CONFIG_DIR: tmp() };
  assert.equal(loadConfig({ env, flags: { tls: "off" }, find: noAgents }).config.tls, "off");
  assert.deepEqual(loadConfig({ env, flags: { tls: "/a/c.pem,/a/k.pem" }, find: noAgents }).config.tls, { cert: "/a/c.pem", key: "/a/k.pem" });
  assert.throws(() => loadConfig({ env, flags: { tls: "maybe" }, find: noAgents }), /tls/);
});

test("default agents: shell always, claude/codex/aider only when found on PATH", () => {
  const only = (names) => (c) => (names.includes(c) ? `/x/${c}` : null);
  const a = defaultAgents({ SHELL: "/bin/zsh" }, only(["/bin/zsh"]));
  assert.deepEqual(a.map((x) => x.id), ["shell"]);
  assert.equal(a[0].command, "/bin/zsh");
  const b = defaultAgents({ SHELL: "/bin/zsh" }, only(["/bin/zsh", "claude", "aider"]));
  assert.deepEqual(b.map((x) => x.id), ["shell", "claude", "aider"]);
  assert.deepEqual(b[1].resumeArgs, ["--continue"]);
  const c = defaultAgents({}, only(["bash"]));
  assert.equal(c[0].command, "bash");
});

test("agent validation", () => {
  assert.throws(() => validateAgents([]), ConfigError);
  assert.throws(() => validateAgents([{ id: "Bad Id", command: "x" }]), /id/);
  assert.throws(() => validateAgents([{ id: "a", command: "x" }, { id: "a", command: "y" }]), /duplicate/);
  assert.throws(() => validateAgents([{ id: "a", command: "x", args: "nope" }]), /array/);
  const ok = validateAgents([{ id: "pi", command: "pi", resumeArgs: ["--continue"] }]);
  assert.deepEqual(ok[0], { id: "pi", label: "pi", command: "pi", args: [], resumeArgs: ["--continue"] });
});

test("isLoopback", () => {
  for (const h of ["127.0.0.1", "127.5.5.5", "localhost", "::1"]) assert.equal(isLoopback(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.5", "example.com"]) assert.equal(isLoopback(h), false, h);
});
