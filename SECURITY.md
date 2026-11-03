# Security

## Threat model

**Anyone who has the access token gets an interactive shell as the user running agent-terminal.** That is the whole product: it is a remote terminal. Treat the token like an SSH private key.

What agent-terminal does to limit exposure:

- A random token (24 bytes, base64url) is generated on first run and stored in `config.json` with mode 600 in a mode 700 directory.
- **Every route except `GET /healthz` requires the token**, including requests from localhost (reverse proxies such as `tailscale serve` connect from localhost, so a localhost bypass would be a full bypass). The only other public paths are `/manifest.webmanifest` and `/icons/icon-{192,512}.png`, which contain nothing secret and which browsers fetch without credentials for PWA install. `/healthz` returns only `{ok, version}`.
- The token is accepted as an `Authorization: Bearer` header, an HttpOnly + SameSite=Strict cookie (Secure over HTTPS), or a `?token=` query on the page URL, which is immediately exchanged for the cookie and redirected away so it does not stay in history or `Referer`. It is not stored in `localStorage` or page JavaScript. Comparison is constant time.
- Bad tokens are rate limited per source address with exponential backoff (HTTP 429); the correct token always works, so an attacker cannot lock the owner out.
- The WebSocket checks `Origin` against `Host` (blocks cross-site WebSocket hijacking from a page the owner visits) and `/api/transcribe` does the same; the cookie is SameSite=Strict.
- It binds to `127.0.0.1` by default. Non-loopback hosts default to TLS (`tls: auto`, self-signed), and a warning is printed when serving plain HTTP on a non-loopback address.
- The token is never logged after the first-run print, and that print only happens on an interactive terminal. `agent-terminal token` shows it on demand.
- Agents are started from an argv array through tmux, never from a shell string built from user input. The working directory must be an existing absolute directory. Spawned processes get your environment minus `AGENT_TERMINAL_*`, `TMUX` and `TMUX_PANE`.
- It uses a dedicated tmux socket and refuses the name `default`, so it never reads or kills sessions on your normal tmux server. Watched `groups` sockets are attach/type/kill only.
- Responses carry `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a Content-Security-Policy.

What it does **not** do:

- No user accounts, no per-session permissions, no audit log, no 2FA. One token, full access.
- No sandboxing of agents on the native install: they run as you. Use the container option (README) to confine them, and do not mount secrets you are not willing to expose.
- The self-signed certificate protects against passive sniffing but not against an active man-in-the-middle unless you pin it; prefer `tailscale serve` (real certificates) for anything beyond your own LAN.
- Never expose it directly to the public internet.

## Recommendations

1. Keep it on loopback and publish it through Tailscale (or another private network).
2. Rotate the token if it leaks: delete `token` from `config.json` (or set a new `AGENT_TERMINAL_TOKEN`) and restart.
3. Run it as an unprivileged user, never as root.
4. Keep Node, tmux and this package up to date.

## Reporting a vulnerability

Please report privately to the maintainers (Axo Insights) rather than opening a public issue; include the version (`agent-terminal --version`), the steps to reproduce and the impact. We aim to acknowledge within a few days.
