---
name: tmux-terminals
description: >-
  Install, run, expose, diagnose and script Tmux Terminals — a self-hosted, phone-friendly
  web terminal for coding agents (Claude Code, Codex, aider, pi, or a plain shell) that keep
  running in tmux on your own machine. Use when the user wants to start or steer a coding
  agent from their phone or another device, keep agent sessions alive across closed tabs,
  flaky Wi-Fi and server restarts, put tmux-terminals on a laptop/server (npm, git or Docker),
  reach it over Tailscale / LAN / nginx / a reverse proxy, make it start at boot, fix it with
  `doctor` / `smoke` / `/healthz`, or drive sessions programmatically over its HTTP +
  WebSocket API.
---

# Tmux Terminals

A web UI (xterm.js + PWA) in front of a **dedicated tmux server** on the user's own machine.
Every session is a tmux session, so agents survive restarts of the web server, closed tabs and
network drops. Two devices can watch the same session. Nothing is hosted: the server only listens
on the address you choose.

Use this skill to (a) install and run it for the user, (b) expose it so their phone can reach it,
(c) diagnose it, (d) script it. Upstream: <https://github.com/axoinsights/tmux-terminals>.

## When to use it

- "Let me run/watch Claude Code from my phone", "keep my agents running when I close the laptop".
- The user (or another agent) started a long agent job in tmux and needs a mobile UI for it.
- Something about a running tmux-terminals is broken: port, token, TLS, proxy, WebSocket.
- Automation: list sessions, or drive a session from a script.

Do not use it for: plain tmux scripting on the user's own tmux server (`tmux new -A -s x`), or for
hosting agents in the cloud — this serves a machine you already control.

## Non-negotiable rules

1. **The access token is a shell as that user.** Hand it to the user in the private conversation
   only. Never put it in a file you commit, a log, an issue, a README, a screenshot, or a URL you
   paste into a public place. `tmux-terminals token` prints it; `config show` redacts it.
2. **Never run a bare `tmux kill-server`.** The tool uses its own socket, `-L tmux-terminals`.
   Ending sessions: `tmux -L tmux-terminals kill-server`, and only when the user asked.
3. **Loopback by default.** `--host 0.0.0.0` publishes a shell to the LAN; it turns on
   self-signed TLS automatically. Prefer Tailscale. Say out loud which one you did.
4. **Do not create sessions in arbitrary folders** — the working directory must be an existing
   absolute path, and it is where an agent will read and write. Ask if unsure.
5. Stopping the web server does **not** stop the agents. Say so instead of implying it.

## Fast path (already installed)

```bash
tmux-terminals status --json || tmux-terminals doctor --json   # what is wrong?
tmux-terminals start --daemon && node -e "fetch('http://127.0.0.1:8767/healthz').then(r=>console.log(r.status))"
tmux-terminals token --url      # pairing URL for the phone (add --qr to scan it)
```

`doctor --json` exits 0 with `"ok": true` when healthy. For every entry in `checks` with
`"status": "fail"`, its `message` says what is wrong and its `fix` says what to run. Apply, re-run.

## Install (non-interactive, each step checkable)

Prerequisites: Node 20+, tmux (`apt-get update && apt-get install -y tmux`,
`dnf install -y tmux`, `brew install tmux`), Linux or macOS (Windows: WSL2).

```bash
npm install -g tmux-terminals          # puts `tmux-terminals` on PATH
# one-off without installing:  npx --yes tmux-terminals doctor --json
# from source: git clone https://github.com/axoinsights/tmux-terminals && cd tmux-terminals && npm install
# in a container (agents confined): docker compose up -d --build
```

Check: `tmux-terminals --version`, then `tmux-terminals doctor --json`.
Full ordered flow (install → verify → start → access → service → stop): `reference/setup.md`.

## Run it

| Need | Command |
| --- | --- |
| Foreground (blocks) | `tmux-terminals` |
| Background | `tmux-terminals start --daemon` (log: `~/.config/tmux-terminals/tmux-terminals.log`) |
| Is it up? | `tmux-terminals status --json` (exit 0 = running) |
| Stop | `tmux-terminals stop` |
| Health, no token | `GET /healthz` → `{"ok":true,"version":"..."}` |
| End-to-end auth + WS test | `tmux-terminals smoke --json` |
| Start at boot | `tmux-terminals install-service` (writes a systemd user unit / launchd agent, enables nothing by itself) |

## Exposing it to a phone

Pick one and tell the user:

- **Tailscale (best)**: leave it on `127.0.0.1:8767`, then
  `tailscale serve --bg --https=443 http://127.0.0.1:8767`; open
  `https://<machine>.<tailnet>.ts.net/` and paste the token.
- **LAN**: `tmux-terminals stop && tmux-terminals config set host 0.0.0.0 && tmux-terminals start --daemon`
  (self-signed cert; the browser warns once). Then re-check health and run `smoke`.
- **nginx / Caddy / tunnel**: forward the WebSocket upgrade and **keep the original `Host`
  header** (`proxy_set_header Host $host;`) — the server rejects a rewritten Host with 403.

Then `tmux-terminals token --qr`, scan it, and "Add to Home screen". Microphone dictation and
clipboard need HTTPS, hence TLS for any non-loopback bind.

## Config

Precedence: flags > `TMUX_TERMINALS_*` env vars > `~/.config/tmux-terminals/config.json`.

```bash
tmux-terminals config show            # token redacted
tmux-terminals config path            # the file to edit for agents / groups / cwdPresets
tmux-terminals config set port 8800   # scalar keys only, then restart
```

Flags are per invocation and are not saved back to config.json: if you start with
`--port 8800`, then `status`, `smoke`, `token` and `scripts/sessions.mjs` all need that same port
(`--port 8800`, or `TMUX_TERMINALS_PORT=8800`, or `--url http://127.0.0.1:8800`). Use
`config set` when the change should be permanent.

`agents`, `groups`, `cwdPresets` and the dictation settings are only editable in the JSON file
(then `tmux-terminals stop && tmux-terminals start --daemon`). Every key, flag and env var:
`reference/cli.md`. Adding a non-default agent CLI (e.g. `pi`) is a 4-line JSON block there.

## Scripting it

`scripts/sessions.mjs` lists the sessions of a running server (read-only, no token on the command
line — it reads the config file):

```bash
node scripts/sessions.mjs                 # or --json, or --url http://host:port
```

It reads the token from the config file (never from argv) and exits 1 with a readable reason when
the server is not there.

HTTP + WebSocket message protocol and a Node example that spawns a session, types into it and
reads the output: `reference/api.md`. Sessions created over the API are the same ones the phone
UI shows.

## When something is wrong

Symptom → cause → fix table (401 everywhere, 429, WS 403 behind a proxy, node-pty build, port in
use, `dist/ is missing`, sessions not re-attached): `reference/troubleshooting.md`. The short
version is always: `doctor --json`, then `/healthz`, then `smoke --json`, in that order.
