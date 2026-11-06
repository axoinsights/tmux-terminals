# Setup flow, non-interactive

Every step is safe to re-run, needs no TTY, and has a pass/fail check. Exit code 0 means success.
Same content as `AGENTS.md` upstream, condensed for an agent that already has the skill.

## 0. Prerequisites

```bash
node --version     # >= 20
tmux -V            # install if missing: apt-get update && apt-get install -y tmux | dnf install -y tmux | brew install tmux
```

Windows: run everything inside WSL2. `openssl` is only needed for automatic self-signed TLS.

## 1. Install

```bash
npm install -g tmux-terminals
tmux-terminals --version
```

Alternatives: `npx --yes tmux-terminals <subcommand>` (nothing installed), or from a checkout
(`git clone https://github.com/axoinsights/tmux-terminals && cd tmux-terminals && npm install` —
`npm install` runs `prepare`, which compiles TypeScript into `dist/`; check
`test -f dist/cli.js`), or from a tarball (`npm pack` then `npm install -g ./tmux-terminals-*.tgz`),
or in a container (`docker compose up -d --build`; the image holds node, tmux, git and a shell
agent only — add agent CLIs with the `NPM_AGENTS` build arg, then
`docker compose exec tmux-terminals tmux-terminals token --url`).

## 2. Verify the machine

```bash
tmux-terminals doctor --json
```

Pass: exit 0 and `"ok": true`. Otherwise read each `checks[]` entry with `"status": "fail"`;
`message` explains the problem, `fix` gives the command. Apply and re-run. `"warn"` entries do not
fail the run. Typical failures: tmux absent, port taken (pick another with `--port`), no prebuilt
`node-pty` binary for the platform (follow its `fix`).

## 3. Start

```bash
tmux-terminals start --daemon
```

Pass: prints `tmux-terminals running in the background (pid N), http://127.0.0.1:8767` and exits 0.
Foreground instead: plain `tmux-terminals` (blocks; stop with Ctrl-C).

Health, no token needed (`curl` may be missing, node never is):

```bash
node -e "fetch('http://127.0.0.1:8767/healthz').then(r=>r.text()).then(t=>console.log(t),()=>process.exit(1))"
```

Expected `{"ok":true,"version":"0.1.0"}` (your port if you changed it).

Authenticated end-to-end check — spawns a shell, echoes a marker, kills it:

```bash
tmux-terminals smoke --json      # pass: exit 0, last line "smoke ok"; pass the same --port you started with
```

## 4. Hand the user their access

```bash
tmux-terminals token --url       # pairing URL(s) with the token
tmux-terminals token --qr        # QR code to scan with the phone camera
```

The page sets a cookie and redirects to a clean URL, so the token leaves the address bar. On the
phone: browser menu → Add to Home screen / Install app (opens full screen).

Default bind is `127.0.0.1`, which the phone cannot reach. Choose one and report which:

```bash
# Tailscale (recommended: real HTTPS, nothing exposed)
tailscale serve --bg --https=443 http://127.0.0.1:8767

# LAN (self-signed TLS is generated automatically)
tmux-terminals stop
tmux-terminals config set host 0.0.0.0
tmux-terminals start --daemon
# re-check: NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch('https://127.0.0.1:8767/healthz').then(r=>r.text()).then(console.log)"
# and: tmux-terminals smoke

# Cloudflare Tunnel: the connector must forward the original Host header and the WebSocket upgrade
cloudflared tunnel --url http://127.0.0.1:8767    # quick test only; use an ingress config for real use
```

For any reverse proxy: `proxy_set_header Host $host;` plus WebSocket upgrades, or the origin check
answers 403 to the upgrade.

## 5. Survive reboot (optional)

```bash
tmux-terminals stop                 # if it was started with --daemon
tmux-terminals install-service      # writes the unit/plist, enables nothing, prints the commands
```

Linux:

```bash
systemctl --user daemon-reload
systemctl --user enable --now tmux-terminals
loginctl enable-linger "$USER"      # keep running with no login session
journalctl --user -u tmux-terminals # logs
```

macOS:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.axoinsights.tmux-terminals.plist
```

Flags given to `install-service` (`--host`, `--port`) are written into the unit.
`--dry-run` previews, `--force` overwrites an existing unit.

## 6. Stop

- daemon: `tmux-terminals stop`
- service: `systemctl --user disable --now tmux-terminals`
- foreground: SIGINT/SIGTERM to that PID (never `pkill` by pattern)

Agents keep running in tmux afterwards (socket `tmux-terminals`) and are re-attached on the next
start (`adopted N running session(s)` in the log). To end them:
`tmux -L tmux-terminals kill-server` — a bare `tmux kill-server` would kill the user's own tmux.
