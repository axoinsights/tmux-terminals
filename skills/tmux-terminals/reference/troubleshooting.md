# Symptom → cause → fix

| Symptom | Cause | Fix |
| --- | --- | --- |
| `doctor`: `tmux` fails | tmux not installed | `apt-get update && apt-get install -y tmux` / `dnf install -y tmux` / `brew install tmux` |
| `doctor`: `node-pty` fails | no prebuilt binary for this platform | follow its `fix`: install build tools, then `npm rebuild @homebridge/node-pty-prebuilt-multiarch --build-from-source` |
| `doctor`: `port` fails | something else owns 8767 | `tmux-terminals config set port 8800` (or `--port 8800`) and restart |
| `start` says `dist/ is missing` | checkout not built | `npm install` (or `npm run build`) in the checkout |
| `401` everywhere, even from localhost | the token is required on every route; reverse proxies also come from localhost | open the URL from `token --url`, or send `Authorization: Bearer <token>` |
| `429` with `Retry-After` | too many wrong tokens from this address | wait, then use the right token; do not loop |
| WebSocket upgrade answers `403` | proxy rewrote `Host` (origin check) | `proxy_set_header Host $host;` and pass the upgrade headers |
| WebSocket answers `404` | wrong path — the socket is `/ws` | fix the proxy path, do not strip prefixes |
| Page loads but no terminal | proxy buffering / no WS upgrade | `proxy_http_version 1.1;` + `Upgrade`/`Connection` headers, disable buffering |
| Phone cannot reach it | server bound to `127.0.0.1` | Tailscale serve, or `config set host 0.0.0.0` (TLS auto), or a tunnel — then re-run `smoke` |
| Mic / clipboard dead on the phone | those browser APIs need HTTPS | use TLS (`auto` for non-loopback, or a real cert via `--tls cert.pem,key.pem`) |
| Sessions vanished after a reboot | rebooting ends all tmux sessions | expected; only restarting the *server* re-adopts them (`adopted N running session(s)` in the log) |
| A session group is empty | the tmux socket does not exist yet | start something on it: `tmux -L work new -d -s hello`; it is polled every few seconds |
| Agents list is missing `codex`/`aider`/`pi` | not on the server's `PATH` | install them, or add them to `agents` in the file from `config path` (setting `agents` replaces the defaults) |
| Wrong folder in the New session dialog | `cwdPresets` | edit `cwdPresets` in that same file (absolute paths, `~` expands) |
| Lost the token | it lives in config.json | `tmux-terminals token --url` (or `--qr`) |
| Rotated the token but the browser is stuck | stale cookie | any valid presented token wins; reload the pairing URL once |
| `smoke` fails but `/healthz` is fine | auth or WS path | check the token, the port and the proxy `Host` handling; `smoke --json` names the failing step |

## Order of diagnosis

1. `tmux-terminals status --json` — is the process running?
2. `tmux-terminals doctor --json` — environment, config, port, TLS.
3. `GET /healthz` — is HTTP answering?
4. `tmux-terminals smoke --json` — auth + WebSocket + a real shell round trip.
5. `tmux -L tmux-terminals ls` — do the tmux sessions still exist? (`no server running` = no
   sessions yet, which is normal on a fresh machine.)
6. Logs: `~/.config/tmux-terminals/tmux-terminals.log` for `--daemon`,
   `journalctl --user -u tmux-terminals` for the systemd user service.

## Reinstall from scratch, keeping the agents

```bash
tmux-terminals stop                 # the agents stay alive in tmux
npm install -g tmux-terminals@latest
tmux-terminals doctor --json
tmux-terminals start --daemon
```

Config and session registry are in `~/.config/tmux-terminals/` and survive. To reset the tool
completely (this **does** drop the sessions): `tmux -L tmux-terminals kill-server` and remove that
directory — confirm with the user first.
