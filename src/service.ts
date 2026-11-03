/** `install-service`: writes a systemd user unit (Linux) or a launchd agent (macOS). Never enables anything itself. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ServiceSpec {
  node: string;
  script: string;
  /** Extra CLI args after `start` (e.g. ["--host", "0.0.0.0"]). */
  args: string[];
  path: string;
  logFile: string;
}

const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

export function systemdUnit(spec: ServiceSpec): string {
  const exec = [spec.node, spec.script, "start", ...spec.args].map(sdQuote).join(" ");
  return [
    "[Unit]",
    "Description=Agent Terminal (web terminal for coding agents)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    `Environment=${sdQuote("PATH=" + spec.path)}`,
    "Restart=on-failure",
    "RestartSec=3",
    "# Agents live in tmux and must survive a restart of this service.",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec, label = "dev.agent-terminal"): string {
  const argv = [spec.node, spec.script, "start", ...spec.args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(spec.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

export interface InstallResult {
  platform: "linux" | "darwin";
  file: string;
  content: string;
  wrote: boolean;
  commands: string[];
}

export function installService(spec: ServiceSpec, opts: { dryRun?: boolean; force?: boolean; home?: string; platform?: NodeJS.Platform } = {}): InstallResult {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  if (platform === "linux") {
    const file = path.join(home, ".config", "systemd", "user", "agent-terminal.service");
    const content = systemdUnit(spec);
    const commands = ["systemctl --user daemon-reload", "systemctl --user enable --now agent-terminal", "loginctl enable-linger \"$USER\"   # optional: keep it running after you log out"];
    return { platform: "linux", file, content, wrote: write(file, content, opts), commands };
  }
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", "dev.agent-terminal.plist");
    const content = launchdPlist(spec);
    const commands = [`launchctl bootstrap gui/$(id -u) ${file}`, "launchctl kickstart -k gui/$(id -u)/dev.agent-terminal"];
    return { platform: "darwin", file, content, wrote: write(file, content, opts), commands };
  }
  throw new Error(`install-service supports Linux (systemd) and macOS (launchd); on ${platform} use WSL.`);
}

function write(file: string, content: string, opts: { dryRun?: boolean; force?: boolean }): boolean {
  if (opts.dryRun) return false;
  if (fs.existsSync(file) && !opts.force) throw new Error(`${file} already exists (use --force to overwrite)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o644 });
  return true;
}
