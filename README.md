# agent-terminal

A self-hosted, phone-friendly web terminal for driving coding agents (Claude Code, Codex, aider, pi, or a plain shell) that run in **tmux on your own machine**.

Start an agent on your laptop or server, walk away, and keep steering it from your phone. Sessions live in tmux, so they survive closed tabs, flaky Wi-Fi and server restarts.

> Screenshot: add `docs/screenshot.png` (sidebar with sessions on the left, Claude Code in xterm.js on the right, mobile key toolbar at the bottom).

- **Persistent**: every session is a tmux session on a dedicated socket. Restart the server, the agents keep running and are re-attached.
- **Built for thumbs**: key toolbar (Esc, Tab, arrows, Ctrl-C...), a compose bar for autocorrect/voice typing, Paste / Copy / Screen buttons, select mode, swipe gestures, install as an app (PWA).
- **Many sessions**: sidebar with rename, kill, drag-and-drop order (shared by all your devices), split view, scrollback search, OSC 52 clipboard.
- **Safe by default**: random token required on every route (also from localhost), loopback bind, WebSocket origin check, no shell strings, your own tmux server is never touched.
- **Easy to install, for people and for AI agents**: `npm install`, `agent-terminal doctor --json`, `GET /healthz`. See [AGENTS.md](AGENTS.md).

Linux and macOS. On Windows, use WSL2.

## Quick start (30 seconds)

You need Node 20+ and tmux (`apt-get install -y tmux`, `dnf install tmux` or `brew install tmux`).

```bash
git clone <this-repo-url> agent-terminal && cd agent-terminal
npm install          # also builds dist/
npm start
```

On the first run it creates `~/.config/agent-terminal/config.json` (mode 600) with a random access token and prints a URL plus a QR code. Open the URL, press **New session**, pick an agent and a folder.

```
agent-terminal 0.1.0 listening on http://127.0.0.1:8767 (tmux socket "agent-terminal", agents: shell, claude)
Open this on the device you want to use (it contains your access token):
  http://127.0.0.1:8767/?token=...
```

Something wrong? `npm run doctor` (or `agent-terminal doctor`) checks Node, tmux, the native pty module, config, port and TLS, and prints the fix for each problem.

### Other ways to install

| Way | Commands |
| --- | --- |
| From a git checkout (main path) | `npm install && npm start` |
| From a tarball (what `npx agent-terminal` will be once published) | `npm pack` then `npx ./agent-terminal-0.1.0.tgz` or `npm install -g ./agent-terminal-0.1.0.tgz` |
| In a container (sandbox option) | `docker compose up -d --build`, see [Container](#container-sandbox-option) |

Run it in the background: `agent-terminal start --daemon` (stop with `agent-terminal stop`), or install it as a service: `agent-terminal install-service` (writes a systemd user unit on Linux or a launchd agent on macOS and prints the commands to enable it; it never enables anything silently).

## Using it from your phone

1. Make the server reachable (see next section).
2. On the host run `agent-terminal token --qr` and scan the QR code with the phone camera. The page sets a cookie and redirects to a clean URL, so the token is not left in the address bar or history.
3. Browser menu, "Add to Home screen" / "Install app": it opens full screen like an app.

If you lose the cookie, open the URL again or type the token into the form that appears at `/`.

## Exposing it safely

By default it binds `127.0.0.1` only. Anyone who has the token gets a shell as your user (see [SECURITY.md](SECURITY.md)), so prefer a private network.

**Tailscale (recommended: real HTTPS, nothing exposed to the internet)**

```bash
agent-terminal                       # stays on 127.0.0.1:8767
tailscale serve --bg --https=443 http://127.0.0.1:8767
```

Open `https://<your-machine>.<tailnet>.ts.net/` on the phone and use the token. The proxy connects from localhost; that is fine because the token is required there too.

**Same Wi-Fi / LAN**

```bash
agent-terminal --host 0.0.0.0        # tls: auto generates a self-signed certificate (needs openssl)
```

Browsers warn about the self-signed certificate once; accept it. Microphone and clipboard APIs need HTTPS, which is why `auto` TLS turns on for any non-loopback host. Use `--tls off` only behind a proxy that terminates TLS, or `--tls cert.pem,key.pem` for your own certificate.

**Other reverse proxies (nginx, Caddy)**: forward WebSocket upgrades and keep the original `Host` header (`proxy_set_header Host $host;`), otherwise the origin check rejects the WebSocket.

## Configuration

Precedence: **CLI flags > `AGENT_TERMINAL_*` environment variables > `~/.config/agent-terminal/config.json` > defaults.** The config directory can be moved with `--config-dir` or `AGENT_TERMINAL_CONFIG_DIR` (it also honours `XDG_CONFIG_HOME`). Order of sessions and the session registry live next to it (`order.json`, `sessions.json`; override with `AGENT_TERMINAL_STATE_DIR`).

| Field | Env var | Flag | Default | Meaning |
| --- | --- | --- | --- | --- |
| `host` | `AGENT_TERMINAL_HOST` | `--host` | `127.0.0.1` | Bind address. `0.0.0.0` serves the LAN. |
| `port` | `AGENT_TERMINAL_PORT` | `--port` | `8767` | Port. |
| `token` | `AGENT_TERMINAL_TOKEN` | none (argv shows in `ps`) | generated | At least 16 characters. Generated on first run into `config.json` (mode 600). |
| `tls` | `AGENT_TERMINAL_TLS` | `--tls` | `auto` | `auto`: self-signed certificate when host is not loopback. `off`. Or `{ "cert": "...", "key": "..." }` (flag form `cert.pem,key.pem`). |
| `agents` | `AGENT_TERMINAL_AGENTS` (JSON) | none | see below | What the "New session" dialog offers. |
| `tmuxSocket` | `AGENT_TERMINAL_TMUX_SOCKET` | `--tmux-socket` | `agent-terminal` | Dedicated tmux socket name. `default` is refused: your own tmux server is never used. |
| `groups` | `AGENT_TERMINAL_GROUPS` (JSON) | none | none | Extra tmux sockets to show as their own sidebar group. |
| `transcribeUrl` | `AGENT_TERMINAL_TRANSCRIBE_URL` | none | unset | OpenAI-compatible `/v1/audio/transcriptions` URL. The mic button is hidden when unset. |
| `transcribeModel` | `AGENT_TERMINAL_TRANSCRIBE_MODEL` | none | `whisper-1` | Model name sent to that endpoint. |
| `transcribeApiKey` | `AGENT_TERMINAL_TRANSCRIBE_API_KEY` | none | unset | Sent as `Authorization: Bearer ...` to the transcription endpoint. |
| `cwdPresets` | `AGENT_TERMINAL_CWD_PRESETS` (comma list) | none | `["~"]` | Folder shortcuts in the New session dialog. |

### Agents

An agent is `{ id, label, command, args, resumeArgs }`. `command` is resolved on `PATH` at spawn time (or give an absolute path); `args` is an argv array and is never passed through a shell. `resumeArgs` are appended when the user ticks "Resume previous conversation" (the checkbox only appears for agents that have them).

If you configure nothing you get `shell` (your `$SHELL`) plus `claude`, `codex` and `aider` **only if they are found on PATH**. Setting `agents` replaces that list entirely:

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

Spawned processes inherit your environment minus `AGENT_TERMINAL_*`, `TMUX` and `TMUX_PANE`. The working directory must be an existing absolute directory (`~` is expanded).

### Watched tmux sockets (groups)

Already running agents in another tmux server (for example one that a script or a cloud runner starts with `tmux -L work`)? Show them in the sidebar as their own group, attachable and typeable like any session:

```json
{ "groups": [ { "label": "Work", "socket": "work" } ] }
```

Every session on that socket is listed (polled every few seconds). Set a nicer title with `tmux -L work set-option -t <session> @agent_terminal_title "Fix flaky test"`. The socket must not be `default` or your main `tmuxSocket`.

### Dictation (optional)

Point `transcribeUrl` at any OpenAI-compatible speech-to-text endpoint, for example a local faster-whisper server (`http://127.0.0.1:8000/v1/audio/transcriptions`). The mic button records in the browser (HTTPS needed), posts the audio to `/api/transcribe`, and types the text into the active session without pressing Enter.

### Wrapping the page in an app

If you embed the page in a WebView, you can provide an optional `window.nativeClipboard` bridge (WebViews usually block `navigator.clipboard.readText()`). It is feature-detected and does nothing when absent. It takes `postMessage(string)` with JSON messages: `{"t":"read","id":N}` (the app answers on the object's `message` event with `{"t":"clip","id":N,"text":"..."}`) and `{"t":"write","text":"..."}`.

## CLI

```
agent-terminal [start] [--host --port --tls --tmux-socket --config-dir] [--daemon] [--show-token]
agent-terminal stop | status [--json]
agent-terminal doctor [--json]          exit code 1 when a check fails
agent-terminal token [--url | --qr | --json]
agent-terminal install-service [--dry-run] [--force]
```

`GET /healthz` needs no token and returns only `{"ok":true,"version":"..."}`.

The token is printed (URL and QR) once, on the very first start in an interactive terminal. It is never written to logs afterwards (non-interactive starts, such as services, never print it). Show it again with `agent-terminal token --url`.

## Container (sandbox option)

Native is the main path. If you want the agents confined to a container and one mounted folder:

```bash
docker compose up -d --build            # or: podman compose up -d --build
docker compose exec agent-terminal agent-terminal token --url
```

`compose.yaml` publishes `127.0.0.1:8767` and mounts `./workspace` at `/workspace`. The image contains node, tmux and git and only a shell agent; add agent CLIs with the `NPM_AGENTS` build arg (for example `"@anthropic-ai/claude-code @openai/codex"`). Sessions survive restarting the server process but not removing the container (use `docker compose restart`, not `down`, to keep running agents). Authenticate the agents inside the container (their own login flow); your host credentials are not shared.

## FAQ

**Why tmux?** It is the boring, proven way to keep processes alive without a daemon of our own. The server is only a tmux *client*: it attaches a pty to each session and relays bytes to xterm.js in the browser. Kill the server, reboot Wi-Fi, close the tab: the agent is untouched. A dedicated socket (`tmux -L agent-terminal`) with its own config keeps it invisible to your normal tmux.

**How do sessions persist?** Each session is a tmux session named `at-<uuid>`. On start the server lists those sessions and re-attaches (it logs `adopted N running session(s)`), restoring titles and the sidebar order from `sessions.json` / `order.json`. Only the red close button (or `pty_kill`) ends an agent. Rebooting the machine ends all tmux sessions, as usual.

**Can two devices use the same session?** Yes. Output goes to all of them and the pty takes the size of the device you last typed on.

**Android keyboard notes.** Gboard composition and suggestions are mirrored to the terminal by diffing the helper textarea, so autocorrect and swipe typing work directly. For the best experience tap **Aa** to open the compose bar: type with autocorrect and voice input, Enter sends (Shift+Enter inserts a newline, multi-line text is sent as a bracketed paste). The key toolbar has Esc, Tab, arrows, Ctrl-C/D/U/R and Enter. Use **Paste**, **Copy**, **Screen** (copy the visible screen) and **Select** (drag-select even while an app captures the mouse) for the clipboard.

**Keyboard shortcuts on desktop.** Ctrl/Cmd+Shift+T new session, +W close, +F search, +C copy, +1..9 jump to a session; Alt+Up/Down reorders the focused sidebar row.

**Does it work on Windows?** Use WSL2 and run it inside the Linux distribution.

**Does it need root, or open outbound connections?** No to both. It only listens on the address you choose. Dictation (opt-in) calls the URL you configure.

## Development

```bash
npm install            # builds dist/ via the prepare script
npm run build          # tsc
npm test               # build, unit tests (node:test), browser end-to-end (Playwright)
```

Browser tests need Playwright: `npm install --no-save playwright && npx playwright install chromium`, or point `PLAYWRIGHT_MODULE` at an existing `playwright/index.mjs`. Every test uses a random port, its own config directory and its own tmux socket, and only cleans up what it started. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
