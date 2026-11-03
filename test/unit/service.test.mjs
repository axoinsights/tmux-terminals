import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { systemdUnit, launchdPlist, installService } from "../../dist/service.js";

const spec = { node: "/usr/bin/node", script: "/opt/a t/bin/agent-terminal.mjs", args: ["--host", "0.0.0.0"], path: "/usr/bin:/home/u/bin%x", logFile: "/tmp/at.log" };

test("systemd unit quotes paths, escapes %, and keeps agents alive across restarts", () => {
  const u = systemdUnit(spec);
  assert.match(u, /ExecStart="\/usr\/bin\/node" "\/opt\/a t\/bin\/agent-terminal.mjs" "start" "--host" "0.0.0.0"/);
  assert.match(u, /Environment="PATH=\/usr\/bin:\/home\/u\/bin%%x"/);
  assert.match(u, /KillMode=process/);
  assert.match(u, /WantedBy=default.target/);
});

test("launchd plist is well formed", () => {
  const p = launchdPlist({ ...spec, path: "/a&b" });
  assert.match(p, /<string>\/a&amp;b<\/string>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
});

test("install-service writes the unit but never enables it; refuses to overwrite without --force", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "at-svc-"));
  const dry = installService(spec, { dryRun: true, home, platform: "linux" });
  assert.equal(dry.wrote, false);
  assert.equal(fs.existsSync(dry.file), false);
  const r = installService(spec, { home, platform: "linux" });
  assert.equal(r.wrote, true);
  assert.ok(r.commands.some((c) => c.startsWith("systemctl --user enable --now")));
  assert.throws(() => installService(spec, { home, platform: "linux" }), /already exists/);
  assert.equal(installService(spec, { home, platform: "linux", force: true }).wrote, true);
  const mac = installService(spec, { home, platform: "darwin" });
  assert.match(mac.file, /LaunchAgents\/dev\.agent-terminal\.plist$/);
  assert.throws(() => installService(spec, { home, platform: "win32" }), /WSL/);
});
