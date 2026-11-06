# CLI, flags, env vars, config keys

## Subcommands

```
tmux-terminals [start] [options]                 start in the foreground
tmux-terminals start --daemon                    start in the background (pid + log in the state dir)
tmux-terminals stop                              stop a --daemon instance (agents keep running in tmux)
tmux-terminals status [--json]                   exit 0 when running
tmux-terminals doctor [--json]                   node, tmux, node-pty, config, port, TLS; exit 1 on failure
tmux-terminals token [--url|--qr|--json]         access token / pairing URL / QR code
tmux-terminals smoke [--json]                    end-to-end test of a running server (auth, WS, shell echo)
tmux-terminals config show|path|set <key> <value>
tmux-terminals install-service [--dry-run] [--force]
tmux-terminals --help | --version
```

`install-service` writes a systemd **user** unit (`tmux-terminals.service`) on Linux or a launchd
agent (`~/Library/LaunchAgents/com.axoinsights.tmux-terminals.plist`) on macOS and prints the
commands to enable it; it never enables anything by itself.

## Flags

| Flag | Meaning |
| --- | --- |
| `--host <addr>` | bind address (default `127.0.0.1`; `0.0.0.0` serves the LAN, with TLS) |
| `--port <n>` | port (default `8767`) |
| `--tls <auto\|off\|cert.pem,key.pem>` | `auto` = self-signed cert when the host is not loopback |
| `--tmux-socket <name>` | dedicated tmux socket (default `tmux-terminals`; `default` is refused) |
| `--config-dir <dir>` | config directory (default `~/.config/tmux-terminals`) |
| `--json` | machine-readable output for `doctor` / `token` / `status` / `smoke` |
| `--show-token` | print the pairing URL + QR at startup even on a non-TTY or later run |
| `--daemon`, `--dry-run`, `--force` | background start / preview only / overwrite existing unit |

Precedence: **flags > `TMUX_TERMINALS_*` env vars > `~/.config/tmux-terminals/config.json` > defaults.**

Flags are per invocation and are **not** written back to config.json: `start --daemon --port 8800`
serves on 8800 only for that process, and `status`/`smoke`/`token` need the same `--port` (or the
same env var) to find it. To make a change permanent use `tmux-terminals config set port 8800`, or
export `TMUX_TERMINALS_PORT` in the service environment.

## Config file

`~/.config/tmux-terminals/config.json`, created on first run, mode 600. `XDG_CONFIG_HOME` and
`--config-dir` / `TMUX_TERMINALS_CONFIG_DIR` move it. `order.json` and `sessions.json` (sidebar
order, session registry) live next to it; move them with `TMUX_TERMINALS_STATE_DIR`.

| Key | Env var | Default | Notes |
| --- | --- | --- | --- |
| `host` | `TMUX_TERMINALS_HOST` | `127.0.0.1` | `0.0.0.0` = LAN |
| `port` | `TMUX_TERMINALS_PORT` | `8767` | |
| `token` | `TMUX_TERMINALS_TOKEN` | generated | ≥ 16 chars; there is no `--token` flag (argv leaks in `ps`) |
| `tls` | `TMUX_TERMINALS_TLS` | `auto` | `auto` \| `off` \| `{"cert": "...", "key": "..."}` |
| `tmuxSocket` | `TMUX_TERMINALS_TMUX_SOCKET` | `tmux-terminals` | never the user's default socket |
| `agents` | `TMUX_TERMINALS_AGENTS` (JSON) | `shell` + `claude`/`codex`/`aider` if on PATH | setting it replaces the list entirely |
| `groups` | `TMUX_TERMINALS_GROUPS` (JSON) | none | watched extra tmux sockets, shown as their own sidebar group |
| `cwdPresets` | `TMUX_TERMINALS_CWD_PRESETS` (comma list) | `["~"]` | folder shortcuts in the New session dialog |
| `transcribeUrl` | `TMUX_TERMINALS_TRANSCRIBE_URL` | unset | any OpenAI-compatible `/v1/audio/transcriptions`; mic hidden when unset |
| `transcribeModel` | `TMUX_TERMINALS_TRANSCRIBE_MODEL` | `whisper-1` | |
| `transcribeApiKey` | `TMUX_TERMINALS_TRANSCRIBE_API_KEY` | unset | sent as `Authorization: Bearer …` to that endpoint |

`config set` writes scalar keys only. `agents`, `groups`, `cwdPresets` and the transcribe block are
edited in the file printed by `config path`, then restart:
`tmux-terminals stop && tmux-terminals start --daemon`. Verify with `doctor --json`.

### Adding an agent (e.g. `pi`)

An agent is `{ id, label, command, args, resumeArgs }`. `command` is resolved on `PATH` at spawn
time (or give an absolute path); `args` is an argv array and never goes through a shell.
`resumeArgs` are appended when the user ticks "Resume previous conversation".

```json
{
  "agents": [
    { "id": "shell",  "label": "Shell",       "command": "bash" },
    { "id": "claude", "label": "Claude Code", "command": "claude", "resumeArgs": ["--continue"] },
    { "id": "codex",  "label": "Codex",       "command": "codex",  "resumeArgs": ["resume", "--last"] },
    { "id": "pi",     "label": "pi",          "command": "pi",     "resumeArgs": ["--continue"] }
  ],
  "cwdPresets": ["~", "~/projects"]
}
```

Spawned processes inherit the environment minus `TMUX_TERMINALS_*`, `TMUX` and `TMUX_PANE`.
`cwd` must be an existing absolute directory (`~` is expanded).

### Watching tmux sockets you already use

```json
{ "groups": [ { "label": "Work", "socket": "work" } ] }
```

Every session on that socket is listed (polled every few seconds) and is attachable/typeable like
any other. Title one nicely with `tmux -L work set-option -t <session> @tmux_terminals_title "Fix flaky test"`.
The socket may not be `default` or your main `tmuxSocket`.

## HTTP endpoints

`GET /healthz` — no token, returns `{"ok":true,"version":"..."}`.
`GET /manifest.webmanifest` and the PWA icons — public and secret-free.
Everything else needs the token, from localhost too, via `Authorization: Bearer <token>`,
the `tmux_terminals_auth` cookie, or `?token=…`:

- `GET /api/config` — version, `home`, the configured `agents` (with `available` and `canResume`),
  `groups`, `cwdPresets`, whether dictation is on.
- `GET /api/sessions` — `{"sessions":[{id,agent,cwd,title,status,startedAt,lastOutputAt,cols,rows,exitCode?}]}`.
- `POST /api/transcribe` — only when `transcribeUrl` is set; proxies audio to it.
- `GET /ws` — the terminal protocol (see `reference/api.md`).

A wrong token from the same address repeats → `429` with `Retry-After`; back off.
