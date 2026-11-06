# WebSocket protocol (`/ws`) and a script example

JSON text frames. Authenticate the upgrade exactly like HTTP: `?token=…`, an
`Authorization: Bearer` header, or the cookie. There is no localhost exemption. If the client
sends an `Origin`, it must match the `Host` the server sees (that is why proxies must forward the
original Host).

## Client → server

```jsonc
{ "type": "pty_spawn",  "agent": "claude", "cwd": "/home/me/project", "cols": 120, "rows": 30, "resume": false }
{ "type": "pty_attach", "sessionId": "at-…" }
{ "type": "pty_detach", "sessionId": "at-…" }
{ "type": "pty_input",  "sessionId": "at-…", "data": "make the test pass\n" }
{ "type": "pty_resize", "sessionId": "at-…", "cols": 120, "rows": 30 }
{ "type": "pty_rename", "sessionId": "at-…", "title": "Fix flaky test" }
{ "type": "pty_kill",   "sessionId": "at-…" }
{ "type": "pty_order",  "order": ["at-…", "at-…"] }
{ "type": "pty_list" }
```

## Server → client

```jsonc
{ "type": "pty_list",       "sessions": [ /* PtySessionInfo[] */ ] }
{ "type": "pty_spawned",    "session": { "id": "at-…", "agent": "claude", "cwd": "…", "title": "…",
                                         "status": "running", "startedAt": 0, "lastOutputAt": 0,
                                         "cols": 120, "rows": 30, "group": "Work" } }
{ "type": "pty_scrollback", "sessionId": "at-…", "data": "…", "truncated": false }
{ "type": "pty_output",     "sessionId": "at-…", "data": "…" }
{ "type": "pty_exit",       "sessionId": "at-…", "code": 0 }
{ "type": "pty_error",      "message": "…", "sessionId": "at-…" }
```

Notes that matter when scripting it:

- `pty_attach` is required before output flows to your socket; after attaching you get a
  `pty_scrollback` dump and then live `pty_output`.
- One pty serves all attached clients and takes the size of whoever typed last, so set
  `pty_resize` to something sane (120×30) if you only read.
- `data` for `pty_input` is sent verbatim — you must include the `\n` yourself. Multi-line text is
  bracketed paste in the web UI; over the raw protocol it is just bytes.
- Sessions are named `at-<uuid>` on tmux socket `tmux-terminals`; a session you spawn over the API
  shows up in the phone UI, and vice versa.
- Only `pty_kill` (or the process exiting) ends an agent. Closing the WebSocket does not.

## Example: spawn, feed, read, leave it running (Node 18+)

```js
import fs from "node:fs";
import os from "node:os";

const dir = process.env.TMUX_TERMINALS_CONFIG_DIR
  ?? (process.env.XDG_CONFIG_HOME || `${os.homedir()}/.config`) + "/tmux-terminals";
const cfg = JSON.parse(fs.readFileSync(`${dir}/config.json`, "utf8"));
// flags are per invocation and are not saved in config.json, so honour the env vars you started with
const host = process.env.TMUX_TERMINALS_HOST || cfg.host || "127.0.0.1";
const port = process.env.TMUX_TERMINALS_PORT || cfg.port || 8767;
const token = process.env.TMUX_TERMINALS_TOKEN || cfg.token;

const ws = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`);
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "pty_spawned") {
    ws.send(JSON.stringify({ type: "pty_resize", sessionId: m.session.id, cols: 120, rows: 30 }));
    ws.send(JSON.stringify({ type: "pty_input", sessionId: m.session.id, data: "npm test\n" }));
    console.log("session", m.session.id);
  } else if (m.type === "pty_output") process.stdout.write(m.data);
  else if (m.type === "pty_exit") console.log("exit", m.code);
  else if (m.type === "pty_error") console.error("error:", m.message);
};
ws.onerror = (e) => console.error("ws error:", e.message ?? e);   // without this a refused port fails silently
ws.onopen = () => ws.send(JSON.stringify({ type: "pty_spawn", agent: "claude", cwd: `${os.homedir()}/projects`, cols: 120, rows: 30 }));
setTimeout(() => ws.close(), 5000);   // closing the socket leaves the agent running
```

Global `WebSocket` needs Node 22+; on Node 20 use `import WebSocket from "ws"` (the
`tmux-terminals` package installs it).

## Example: read-only HTTP

```bash
TOKEN=$(node -e 'const os=require("node:os");console.log(require(process.env.HOME+"/.config/tmux-terminals/config.json").token)')
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8767/api/sessions
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8767/api/config
```

`scripts/sessions.mjs` does the first one without putting the token on the command line.
