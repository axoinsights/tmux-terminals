# AGENTS.md: install, verify, run and stop tmux-terminals (for AI agents)

Every step below is non-interactive (no prompts, no TTY needed) and has a pass/fail check. Run the commands from the repository root unless stated. Exit code 0 means success.

`https://github.com/axoinsights/tmux-terminals.git` is the git URL you were given for this project (or skip step 1 if you already have the directory).

## 0. Prerequisites

- Node.js 20 or newer: `node --version`
- tmux: `tmux -V`. If missing: `apt-get update && apt-get install -y tmux` (Debian/Ubuntu; add `sudo` if not root), `dnf install -y tmux`, `brew install tmux`.
- git (only to clone; `apt-get install -y git`), openssl (only for `--host 0.0.0.0` with automatic TLS).
- Linux or macOS. On Windows, work inside WSL2.

## 1. Install

```bash
git clone https://github.com/axoinsights/tmux-terminals.git tmux-terminals
cd tmux-terminals
npm install
```

`npm install` compiles TypeScript into `dist/` (the `prepare` script) and downloads prebuilt native modules, so no compiler is normally needed. Check: `test -f dist/cli.js && echo built`.

Fastest alternative, from npm: `npm install -g tmux-terminals` puts a `tmux-terminals` command on PATH (or run it once with `npx --yes tmux-terminals doctor --json`); below, replace `node bin/tmux-terminals.mjs` with `tmux-terminals`.

Alternative from a tarball: `npm pack` then `npm install -g ./tmux-terminals-0.1.0.tgz` (or run it once with `npx --yes ./tmux-terminals-0.1.0.tgz doctor --json`; use a path starting with `./`) puts a `tmux-terminals` command on PATH (below, replace `node bin/tmux-terminals.mjs` with `tmux-terminals`).

## 2. Verify the environment

```bash
node bin/tmux-terminals.mjs doctor --json
```

Pass condition: exit code 0 and `"ok": true`. Otherwise read every entry in `checks` whose `status` is `fail`: its `message` says what is wrong and `fix` says what to run. Apply the fix and run `doctor` again. Entries with `status: "warn"` do not fail the run.

Typical fixes: tmux missing, a port in use (pick another with `--port 8800`), native module build tools missing.

## 3. Start it

Foreground (blocks): `node bin/tmux-terminals.mjs start`

Background, no service manager needed:

```bash
node bin/tmux-terminals.mjs start --daemon
```

Pass condition: it prints `tmux-terminals running in the background (pid N), http://127.0.0.1:8767` and exits 0. A log is kept in `~/.config/tmux-terminals/tmux-terminals.log`.

Health check (no token needed; `curl` may be absent, node is always there):

```bash
node -e "fetch('http://127.0.0.1:8767/healthz').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))"
# or: curl -fsS http://127.0.0.1:8767/healthz
```

Expected: `{"ok":true,"version":"0.1.0"}`. (Use the port you chose.)

Optional end-to-end check (authenticated WebSocket, starts a shell, echoes a marker, kills the session):

```bash
node bin/tmux-terminals.mjs smoke        # add --json for machine-readable steps
```

Pass condition: exit code 0 and last line `smoke ok`. (It reads the same config, so pass the same `--port` you started with.)

## 4. Give the user access

The access token is a secret that gives a shell as this user. Do not commit it, log it or paste it anywhere except to the user in the private conversation.

```bash
node bin/tmux-terminals.mjs token --url     # pairing URL(s) containing the token
node bin/tmux-terminals.mjs token           # the token alone
```

By default the server listens on `127.0.0.1` only. To reach it from the user's phone, pick one and tell the user what you did:

- Tailscale: `tailscale serve --bg --https=443 http://127.0.0.1:8767`
- LAN: `node bin/tmux-terminals.mjs stop && node bin/tmux-terminals.mjs config set host 0.0.0.0 && node bin/tmux-terminals.mjs start --daemon` (the setting is saved in config.json; a self-signed TLS certificate is generated and the browser warns once). Then use the `https://<lan-ip>:8767/?token=...` URL from `token --url`, and re-check with `NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch('https://127.0.0.1:8767/healthz').then(r=>r.text()).then(console.log)"` (or `curl -fsSk https://127.0.0.1:8767/healthz`) and `node bin/tmux-terminals.mjs smoke`.

To see or change settings without editing JSON by hand: `node bin/tmux-terminals.mjs config show` (token redacted), `config path`, `config set <host|port|tls|tmuxSocket|transcribeUrl|transcribeModel|transcribeApiKey> <value>`. Agents / groups / cwdPresets are edited in the file shown by `config path`.

## 5. Start at login / boot (optional)

```bash
node bin/tmux-terminals.mjs stop                  # if started with --daemon
node bin/tmux-terminals.mjs install-service       # writes the unit/plist, enables nothing
```

It prints the exact commands to enable it. On Linux (systemd user unit):

```bash
systemctl --user daemon-reload
systemctl --user enable --now tmux-terminals
loginctl enable-linger "$USER"      # optional: keep running without a login session
```

On macOS: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.axoinsights.tmux-terminals.plist`.

Check: `node bin/tmux-terminals.mjs status` (exit 0 = running; add `--json` for scripts) and the health check from step 3. Logs: `journalctl --user -u tmux-terminals` (Linux).

Flags such as `--host`, `--port` given to `install-service` are written into the unit. Use `--dry-run` to preview and `--force` to overwrite an existing unit.

## 6. Stop it

- Started with `--daemon`: `node bin/tmux-terminals.mjs stop`
- Service on Linux: `systemctl --user disable --now tmux-terminals`
- Foreground: SIGINT / SIGTERM to that process (never `pkill` by pattern; use its PID).

Stopping the server does **not** end the agents: they keep running in tmux (socket `tmux-terminals`) and are re-attached on the next start. To end them all: `tmux -L tmux-terminals kill-server`. Never run a bare `tmux kill-server` (that is the user's own tmux).

## Configuration in one paragraph

Precedence: CLI flags > `TMUX_TERMINALS_*` environment variables > `~/.config/tmux-terminals/config.json`. Useful: `TMUX_TERMINALS_PORT`, `TMUX_TERMINALS_HOST`, `TMUX_TERMINALS_TOKEN` (>= 16 chars; otherwise generated on first run), `TMUX_TERMINALS_CONFIG_DIR`. Agents offered in the UI default to `shell` plus `claude` / `codex` / `aider` if they are on PATH; to add others (for example `pi`) edit `agents` in `config.json` (see README.md, "Agents"). Check with `doctor --json` after editing.

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
