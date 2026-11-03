# AGENTS.md: install, verify, run and stop agent-terminal (for AI agents)

Every step below is non-interactive (no prompts, no TTY needed) and has a pass/fail check. Run the commands from the repository root unless stated. Exit code 0 means success.

`<REPO_URL>` is the git URL you were given for this project (or skip step 1 if you already have the directory).

## 0. Prerequisites

- Node.js 20 or newer: `node --version`
- tmux: `tmux -V`. If missing: `apt-get install -y tmux` (Debian/Ubuntu, add `sudo` if not root), `dnf install -y tmux`, `brew install tmux`.
- git (only to clone), openssl (only for `--host 0.0.0.0` with automatic TLS).
- Linux or macOS. On Windows, work inside WSL2.

## 1. Install

```bash
git clone <REPO_URL> agent-terminal
cd agent-terminal
npm install
```

`npm install` compiles TypeScript into `dist/` (the `prepare` script) and downloads prebuilt native modules, so no compiler is normally needed. Check: `test -f dist/cli.js && echo built`.

Alternative from a tarball: `npm pack` then `npm install -g ./agent-terminal-*.tgz` puts an `agent-terminal` command on PATH (below, replace `node bin/agent-terminal.mjs` with `agent-terminal`).

## 2. Verify the environment

```bash
node bin/agent-terminal.mjs doctor --json
```

Pass condition: exit code 0 and `"ok": true`. Otherwise read every entry in `checks` whose `status` is `fail`: its `message` says what is wrong and `fix` says what to run. Apply the fix and run `doctor` again. Entries with `status: "warn"` do not fail the run.

Typical fixes: tmux missing, a port in use (pick another with `--port 8800`), native module build tools missing.

## 3. Start it

Foreground (blocks): `node bin/agent-terminal.mjs start`

Background, no service manager needed:

```bash
node bin/agent-terminal.mjs start --daemon
```

Pass condition: it prints `agent-terminal running in the background (pid N), http://127.0.0.1:8767` and exits 0. A log is kept in `~/.config/agent-terminal/agent-terminal.log`.

Health check (no token needed):

```bash
curl -fsS http://127.0.0.1:8767/healthz
```

Expected: `{"ok":true,"version":"0.1.0"}`. (Use the port you chose.)

Optional end-to-end check (authenticated WebSocket, starts a shell, echoes a marker, kills the session):

```bash
node bin/agent-terminal.mjs smoke        # add --json for machine-readable steps
```

Pass condition: exit code 0 and last line `smoke ok`. (It reads the same config, so pass the same `--port` you started with.)

## 4. Give the user access

The access token is a secret that gives a shell as this user. Do not commit it, log it or paste it anywhere except to the user in the private conversation.

```bash
node bin/agent-terminal.mjs token --url     # pairing URL(s) containing the token
node bin/agent-terminal.mjs token           # the token alone
```

By default the server listens on `127.0.0.1` only. To reach it from the user's phone, pick one and tell the user what you did:

- Tailscale: `tailscale serve --bg --https=443 http://127.0.0.1:8767`
- LAN: restart with `node bin/agent-terminal.mjs stop && node bin/agent-terminal.mjs start --daemon --host 0.0.0.0` (a self-signed TLS certificate is generated; the browser warns once). Then use the `https://<lan-ip>:8767/?token=...` URL from `token --url`.

## 5. Start at login / boot (optional)

```bash
node bin/agent-terminal.mjs stop                  # if started with --daemon
node bin/agent-terminal.mjs install-service       # writes the unit/plist, enables nothing
```

It prints the exact commands to enable it. On Linux (systemd user unit):

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-terminal
loginctl enable-linger "$USER"      # optional: keep running without a login session
```

On macOS: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.agent-terminal.plist`.

Check: `node bin/agent-terminal.mjs status` (exit 0 = running) and `curl -fsS http://127.0.0.1:8767/healthz`. Logs: `journalctl --user -u agent-terminal` (Linux).

Flags such as `--host`, `--port` given to `install-service` are written into the unit. Use `--dry-run` to preview and `--force` to overwrite an existing unit.

## 6. Stop it

- Started with `--daemon`: `node bin/agent-terminal.mjs stop`
- Service on Linux: `systemctl --user disable --now agent-terminal`
- Foreground: SIGINT / SIGTERM to that process (never `pkill` by pattern; use its PID).

Stopping the server does **not** end the agents: they keep running in tmux (socket `agent-terminal`) and are re-attached on the next start. To end them all: `tmux -L agent-terminal kill-server`. Never run a bare `tmux kill-server` (that is the user's own tmux).

## Configuration in one paragraph

Precedence: CLI flags > `AGENT_TERMINAL_*` environment variables > `~/.config/agent-terminal/config.json`. Useful: `AGENT_TERMINAL_PORT`, `AGENT_TERMINAL_HOST`, `AGENT_TERMINAL_TOKEN` (>= 16 chars; otherwise generated on first run), `AGENT_TERMINAL_CONFIG_DIR`. Agents offered in the UI default to `shell` plus `claude` / `codex` / `aider` if they are on PATH; to add others (for example `pi`) edit `agents` in `config.json` (see README.md, "Agents"). Check with `doctor --json` after editing.

## Troubleshooting map

| Symptom | Cause | Fix |
| --- | --- | --- |
| `doctor`: `tmux` fail | tmux not installed | install tmux (step 0) |
| `doctor`: `node-pty` fail | no prebuilt binary for this platform | follow its `fix` (install build tools, `npm rebuild @homebridge/node-pty-prebuilt-multiarch --build-from-source`) |
| `doctor`: `port` fail | another program uses the port | use `--port <n>` or set `port` in config.json |
| `start` says `dist/ is missing` | not built | `npm install` or `npm run build` |
| HTTP 401 everywhere | token required on every route, also from localhost | send `Authorization: Bearer <token>` or open the `token --url` URL |
| HTTP 429 | too many wrong tokens from this address | wait (seconds to minutes) and use the right token |
| WebSocket 403 behind a proxy | proxy rewrote `Host` | forward the original `Host` header |
